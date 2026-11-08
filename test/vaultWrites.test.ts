import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/auth/accounts';
import { LockedAccountStore, MAX_REGISTRATIONS, MAX_VAULT_LENGTH, newVault, parseVault, serializeVault, type VaultState } from '../src/auth/store';
import { MemoryStore, oauth, registration, signal } from './helpers';

function initialVault(count = 1): VaultState {
  const vault = newVault(); vault.registrations = Array.from({ length: count }, (_, index) => registration(`oaiapp_${index}`));
  vault.active = vault.registrations[0]!.clientId; return vault;
}

test('serialization admits only states that can be read by the same vault parser', () => {
  const vault = initialVault(MAX_REGISTRATIONS);
  assert.deepEqual(parseVault(serializeVault(vault)), vault);
  vault.registrations.push(registration('oaiapp_extra'));
  assert.throws(() => serializeVault(vault), /not been overwritten/);
});

for (const failure of ['count', 'size', 'duplicate ID', 'missing active account', 'invalid identity']) {
  test(`a ${failure} write failure preserves the previous vault and releases the filesystem lock`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatgpt-vault-write-test-'));
    let raw = serializeVault(initialVault(failure === 'count' ? MAX_REGISTRATIONS : 1)); const original = raw; let writes = 0;
    const store = new LockedAccountStore({ get: async () => raw, store: async (_key, value) => { raw = value; writes++; } }, directory);
    try {
      await assert.rejects(store.transact(state => {
        if (failure === 'count') state.registrations.push(registration('oaiapp_extra'));
        if (failure === 'size') state.registrations[0]!.tokens!.access = 'x'.repeat(MAX_VAULT_LENGTH);
        if (failure === 'duplicate ID') state.registrations.push(structuredClone(state.registrations[0]!));
        if (failure === 'missing active account') state.active = 'missing';
        if (failure === 'invalid identity') state.registrations[0]!.subject = '';
      }, signal()), /not been overwritten/);
      assert.equal(raw, original); assert.equal(writes, 0); assert.ok(parseVault(raw).registrations[0]!.tokens);
      await assert.rejects(access(join(directory, 'session.lock')));
      await store.transact(state => { state.epoch = 'next-valid-epoch'; }, signal());
      assert.equal(parseVault(raw).epoch, 'next-valid-epoch'); assert.equal(writes, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('account admission stops at capacity before opening a browser or exchanging tokens', async () => {
  const store = new MemoryStore(initialVault(MAX_REGISTRATIONS).registrations); const original = JSON.stringify(store.state);
  let browserOpens = 0; let exchanges = 0;
  const manager = new AccountManager(store, oauth({ exchange: async () => { exchanges++; return registration('oaiapp_extra'); } }));
  try {
    await assert.rejects(manager.login(async () => { browserOpens++; }, signal()), /At most 100/);
    assert.equal(browserOpens, 0); assert.equal(exchanges, 0); assert.equal(JSON.stringify(store.state), original);
  } finally { manager.dispose(); }
});
