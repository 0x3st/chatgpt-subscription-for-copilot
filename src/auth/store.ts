import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { AppError, ISSUER, checkAbort, deadline, record } from '../core';
import type { Registration } from './oauth';

export const SECRET_KEY = 'chatgptSub.accounts.v1';
export const MAX_REGISTRATIONS = 100;
export const MAX_VAULT_LENGTH = 1024 * 1024;
export interface VaultState { version: 1; hostId: string; epoch: string; active?: string; registrations: Registration[] }
export interface SecretStore { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void> }
export interface AccountStore { transact<T>(work: (state: VaultState, signal: AbortSignal) => Promise<T> | T, signal: AbortSignal): Promise<T> }
export function newVault(): VaultState { return { version: 1, hostId: `urn:uuid:${randomUUID()}`, epoch: randomUUID(), registrations: [] }; }
export function parseVault(raw: string | undefined): VaultState {
  if (raw === undefined) return newVault();
  try {
    if (raw.length > MAX_VAULT_LENGTH) throw new Error();
    const state = record(JSON.parse(raw));
    if (!state || state.version !== 1 || typeof state.hostId !== 'string' ||
      !/^urn:uuid:[a-f0-9-]{36}$/i.test(state.hostId) || typeof state.epoch !== 'string' ||
      !Array.isArray(state.registrations) || state.registrations.length > MAX_REGISTRATIONS) throw new Error();
    const ids = new Set<string>();
    for (const value of state.registrations) {
      const reg = record(value);
      if (!reg || reg.issuer !== ISSUER || typeof reg.subject !== 'string' || !reg.subject ||
        typeof reg.clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(reg.clientId) || reg.clientId === 'dynamic_agent_client' ||
        ids.has(reg.clientId) || (reg.email !== undefined && typeof reg.email !== 'string')) throw new Error();
      ids.add(reg.clientId);
      if (reg.tokens !== undefined) {
        const tokens = record(reg.tokens);
        if (!tokens || !['access', 'refresh', 'id'].every(key => typeof tokens[key] === 'string' && (tokens[key] as string).length > 0) ||
          typeof tokens.expiresAt !== 'number' || !Number.isFinite(tokens.expiresAt) ||
          !Array.isArray(tokens.scopes) || !tokens.scopes.every(scope => typeof scope === 'string')) throw new Error();
      }
    }
    if (state.active !== undefined && (typeof state.active !== 'string' || !ids.has(state.active))) throw new Error();
    return state as unknown as VaultState;
  } catch { throw new AppError('Saved account data is invalid and has not been overwritten. Check extension storage or restore a backup.', 'auth'); }
}
export function serializeVault(state: VaultState): string {
  try {
    const next = JSON.stringify(state);
    if (typeof next !== 'string') throw new Error();
    parseVault(next); // Never commit data that the next transaction cannot read.
    return next;
  } catch { throw new AppError('The account changes are invalid or exceed local storage limits. Existing saved account data has not been overwritten.', 'auth'); }
}
async function pause(signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 100); signal.addEventListener('abort', finish, { once: true });
  });
  checkAbort(signal);
}
/** Every window rereads SecretStorage while holding the same machine-local lock, including during refresh. */
export class LockedAccountStore implements AccountStore {
  constructor(private readonly secrets: SecretStore, private readonly directory: string) {}
  async transact<T>(work: (state: VaultState, signal: AbortSignal) => Promise<T> | T, signal: AbortSignal): Promise<T> {
    const compromised = new AbortController();
    const operation = deadline(45000, [signal, compromised.signal]);
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const waitUntil = Date.now() + 35000;
      while (!release) {
        checkAbort(operation.signal);
        try {
          release = await lockfile.lock(this.directory, { lockfilePath: join(this.directory, 'session.lock'), retries: 0,
            stale: 60000, update: 10000, onCompromised: () => compromised.abort() });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw new AppError('Could not lock local account storage.', 'busy');
          if (Date.now() >= waitUntil) throw new AppError('Another VS Code window is updating account data. Try again shortly.', 'busy');
          await pause(operation.signal);
        }
      }
      const raw = await this.secrets.get(SECRET_KEY); checkAbort(operation.signal);
      const state = parseVault(raw);
      const value = await work(state, operation.signal); checkAbort(operation.signal);
      const next = serializeVault(state); checkAbort(operation.signal);
      if (next !== raw) await this.secrets.store(SECRET_KEY, next);
      checkAbort(operation.signal); return value;
    } finally {
      operation.dispose();
      if (release) await release().catch(() => undefined);
    }
  }
}
