import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenForOAuth } from '../src/auth/callback';
import { LockedAccountStore, newVault, parseVault } from '../src/auth/store';
import { deadline } from '../src/core';
import { deferred, signal } from './helpers';

test('OAuth listener ignores wrong state and malformed callbacks without consuming login', async () => {
  const operation = deadline(2000); const listener = await listenForOAuth('expected', operation.signal);
  try {
    assert.ok(listener.redirectUri.startsWith('http://127.0.0.1:'));
    for (const query of ['state=wrong&error=access_denied', 'state=expected&code=x', 'state=expected&code=a&code=b&client_id=oaiapp_A']) {
      const response = await fetch(`${listener.redirectUri}?${query}`); assert.equal(response.status, 400); await response.text();
    }
    const response = await fetch(`${listener.redirectUri}?state=expected&code=valid&client_id=oaiapp_A`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!(await response.text()).includes('valid'));
    assert.deepEqual(await listener.result, { code: 'valid', clientId: 'oaiapp_A' });
  } finally { await listener.close(); operation.dispose(); }
  await assert.rejects(fetch(listener.redirectUri));
});
test('OAuth error requires matching state; valid denial ends login', async () => {
  const operation = deadline(2000); const listener = await listenForOAuth('state', operation.signal);
  try {
    const assertion = assert.rejects(listener.result, /cancelled or denied/);
    const response = await fetch(`${listener.redirectUri}?state=state&error=access_denied`); await response.text(); await assertion;
  } finally { await listener.close(); operation.dispose(); }
});
test('returning login may omit client ID, but cannot replace it', async () => {
  const operation = deadline(2000); const listener = await listenForOAuth('state', operation.signal, 'oaiapp_A');
  try {
    const wrong = await fetch(`${listener.redirectUri}?state=state&code=x&client_id=oaiapp_B`); assert.equal(wrong.status, 400); await wrong.text();
    const right = await fetch(`${listener.redirectUri}?state=state&code=x`); await right.text();
    assert.equal((await listener.result).clientId, 'oaiapp_A');
  } finally { await listener.close(); operation.dispose(); }
});
test('cancellation closes the OAuth port and settles the pending result', async () => {
  const controller = new AbortController(); const listener = await listenForOAuth('state', controller.signal);
  const assertion = assert.rejects(listener.result); controller.abort(); await assertion; await listener.close(); await assert.rejects(fetch(listener.redirectUri));
});
test('credential validation rejects malformed or hostile state without silently resetting it', () => {
  for (const raw of ['null', 'not-json', '{}', JSON.stringify({ ...newVault(), active: 'missing' })]) assert.throws(() => parseVault(raw), /data is invalid/);
  assert.equal(parseVault(undefined).version, 1);
});
test('real filesystem lock serializes two windows and rereads storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-sub-test-'));
  let raw: string | undefined;
  const secrets = { get: async () => raw, store: async (_key: string, value: string) => { raw = value; } };
  const first = new LockedAccountStore(secrets, directory); const second = new LockedAccountStore(secrets, directory);
  const started = deferred(); const finish = deferred();
  try {
    const a = first.transact(async state => { state.epoch = 'first'; started.resolve(); await finish.promise; }, signal());
    await started.promise;
    const b = second.transact(state => { assert.equal(state.epoch, 'first'); state.epoch = 'second'; }, signal());
    finish.resolve(); await Promise.all([a, b]); assert.equal(parseVault(raw).epoch, 'second');
    await assert.rejects(access(join(directory, 'session.lock')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('failed transactions do not write modified credentials and release the lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-sub-test-')); let raw: string | undefined;
  const store = new LockedAccountStore({ get: async () => raw, store: async (_key, value) => { raw = value; } }, directory);
  try {
    await assert.rejects(store.transact(state => { state.epoch = 'bad'; throw new Error('failed'); }, signal())); assert.equal(raw, undefined);
    await store.transact(state => { state.epoch = 'good'; }, signal()); assert.equal(parseVault(raw).epoch, 'good');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
