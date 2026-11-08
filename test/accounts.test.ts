import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountManager } from '../src/auth/accounts';
import { AppError } from '../src/core';
import { MemoryStore, deferred, failure, oauth, registration, signal } from './helpers';

async function browser(url: string): Promise<void> {
  const auth = new URL(url); const callback = new URL(auth.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'mock-code');
  callback.searchParams.set('client_id', auth.searchParams.get('client_id') === 'dynamic_agent_client' ? 'oaiapp_new' : auth.searchParams.get('client_id')!);
  await fetch(callback);
}
test('fresh credentials do not refresh', async () => {
  const manager = new AccountManager(new MemoryStore([registration()]), oauth({ refresh: async () => { throw new Error('unexpected refresh'); } }));
  try { assert.equal((await manager.credentials(signal())).access, 'access-oaiapp_A'); } finally { manager.dispose(); }
});
test('concurrent requests share one rotating refresh through the store lock', async () => {
  let calls = 0; const store = new MemoryStore([registration('oaiapp_A', true)]);
  const manager = new AccountManager(store, oauth({ refresh: async reg => { calls++; return { ...reg, tokens: { ...reg.tokens!, access: 'new', expiresAt: Date.now() + 3600000 } }; } }));
  try {
    const result = await Promise.all(Array.from({ length: 5 }, () => manager.credentials(signal())));
    assert.equal(calls, 1); assert.ok(result.every(item => item.access === 'new'));
  } finally { manager.dispose(); }
});
test('multiple windows serialize refreshes and reread the new token', async () => {
  const store = new MemoryStore([registration('oaiapp_A', true)]); let calls = 0;
  const service = oauth({ refresh: async reg => { calls++; return { ...reg, tokens: { ...reg.tokens!, access: 'rotated', expiresAt: Date.now() + 3600000 } }; } });
  const first = new AccountManager(store, service); const second = new AccountManager(store, service);
  try { await Promise.all([first.credentials(signal()), second.credentials(signal())]); assert.equal(calls, 1); }
  finally { first.dispose(); second.dispose(); }
});
test('signing out during refresh discards even a late successful result', async () => {
  const store = new MemoryStore([registration('oaiapp_A', true)]); const started = deferred(); const finish = deferred();
  const manager = new AccountManager(store, oauth({ refresh: async reg => { started.resolve(); await finish.promise; return registration(reg.clientId); } }));
  const old = manager.credentials(signal()); const assertion = assert.rejects(old, (e: unknown) => e instanceof AppError && e.kind === 'cancelled');
  await started.promise; const signOut = manager.signOut(signal()); finish.resolve(); await assertion; await signOut;
  assert.equal(store.state.active, undefined); assert.equal(store.state.registrations[0]!.tokens, undefined); manager.dispose();
});
test('a stale fatal refresh cannot clear the newly selected account', async () => {
  const store = new MemoryStore([registration('oaiapp_A', true), registration('oaiapp_B')]); const started = deferred(); const finish = deferred();
  const manager = new AccountManager(store, oauth({ refresh: async () => { started.resolve(); await finish.promise; throw failure(); } }));
  const request = manager.credentials(signal()); const assertion = assert.rejects(request);
  await started.promise; const selected = manager.select('oaiapp_B', signal()); finish.resolve(); await assertion; await selected;
  assert.equal((await manager.credentials(signal())).clientId, 'oaiapp_B'); assert.ok(store.state.registrations[1]!.tokens); manager.dispose();
});
test('only terminal machine-readable refresh errors clear tokens and retain registration', async () => {
  for (const code of ['invalid_grant', 'refresh_token_reused']) {
    const store = new MemoryStore([registration('oaiapp_A', true)]); const manager = new AccountManager(store, oauth({ refresh: async () => { throw failure(code); } }));
    await assert.rejects(manager.credentials(signal()), /sign-in has expired/); assert.equal(store.state.registrations[0]!.tokens, undefined);
    assert.equal(store.state.registrations[0]!.clientId, 'oaiapp_A'); manager.dispose();
  }
});
test('network failures and invalid_client preserve credentials', async () => {
  for (const error of [new AppError('temporary', 'network', 503), failure('invalid_client')]) {
    const store = new MemoryStore([registration('oaiapp_A', true)]); const manager = new AccountManager(store, oauth({ refresh: async () => { throw error; } }));
    await assert.rejects(manager.credentials(signal())); assert.ok(store.state.registrations[0]!.tokens); manager.dispose();
  }
});
test('a rotated token is saved even if the returned scope disables inference', async () => {
  const store = new MemoryStore([registration('oaiapp_A', true)]);
  const manager = new AccountManager(store, oauth({ refresh: async reg => ({ ...reg, tokens: { ...reg.tokens!, refresh: 'rotated', scopes: [], expiresAt: Date.now() + 3600000 } }) }));
  await assert.rejects(manager.credentials(signal()), /has not granted/); assert.equal(store.state.registrations[0]!.tokens!.refresh, 'rotated'); manager.dispose();
});
test('declined plan permission never returns credentials for inference', async () => {
  const reg = registration(); reg.tokens!.scopes = ['openid']; const manager = new AccountManager(new MemoryStore([reg]), oauth());
  await assert.rejects(manager.credentials(signal()), (e: unknown) => e instanceof AppError && e.kind === 'permission'); manager.dispose();
});
test('sign-out clears local tokens even when revocation fails', async () => {
  const store = new MemoryStore([registration(), registration('oaiapp_B')]); const manager = new AccountManager(store, oauth({ revoke: async () => false }));
  assert.equal(await manager.signOut(signal()), false); assert.equal(store.state.registrations[0]!.tokens, undefined);
  assert.ok(store.state.registrations[1]!.tokens); assert.equal(store.state.registrations.length, 2); manager.dispose();
});
test('successful login keeps accounts separate even when their emails match', async () => {
  const store = new MemoryStore([registration()]); const hostId = store.state.hostId;
  const manager = new AccountManager(store, oauth());
  await manager.login(browser, signal());
  assert.equal(store.state.registrations.length, 2); assert.equal(store.state.active, 'oaiapp_new'); assert.equal(store.state.hostId, hostId);
  await manager.select('oaiapp_A', signal()); assert.equal((await manager.credentials(signal())).clientId, 'oaiapp_A'); manager.dispose();
});
test('sign-out cancels an in-progress login instead of allowing it to resurrect tokens', async () => {
  const store = new MemoryStore([registration()]); const started = deferred(); const finish = deferred();
  const manager = new AccountManager(store, oauth({ exchange: async () => { started.resolve(); await finish.promise; return registration('oaiapp_new'); } }));
  const login = manager.login(browser, signal()); const assertion = assert.rejects(login);
  await started.promise; await manager.signOut(signal()); finish.resolve(); await assertion;
  assert.equal(store.state.active, undefined); assert.equal(store.state.registrations.length, 1); manager.dispose();
});
test('a cross-window account change during login is not overwritten', async () => {
  const store = new MemoryStore([registration()]); const started = deferred(); const finish = deferred();
  const manager = new AccountManager(store, oauth({ exchange: async () => { started.resolve(); await finish.promise; return registration('oaiapp_new'); } }));
  const login = manager.login(browser, signal()); const assertion = assert.rejects(login, /state changed/);
  await started.promise; store.switchTo(registration('oaiapp_B')); finish.resolve(); await assertion;
  assert.equal(store.state.active, 'oaiapp_B'); manager.dispose();
});
test('external epoch changes cancel streams, but token rotation does not', async () => {
  const store = new MemoryStore([registration()]); const manager = new AccountManager(store, oauth());
  await manager.synchronize(signal()); const first = manager.signal;
  store.state.registrations[0]!.tokens!.access = 'refreshed'; await manager.synchronize(signal()); assert.equal(first.aborted, false);
  store.switchTo(registration('oaiapp_B')); await manager.synchronize(signal()); assert.equal(first.aborted, true); manager.dispose();
});
test('snapshot only exposes display metadata, never access or refresh tokens', async () => {
  const manager = new AccountManager(new MemoryStore([registration()]), oauth()); const snapshot = await manager.snapshot(signal());
  assert.ok(!JSON.stringify(snapshot).includes('access-oaiapp')); assert.ok(!JSON.stringify(snapshot).includes('refresh-oaiapp')); manager.dispose();
});
