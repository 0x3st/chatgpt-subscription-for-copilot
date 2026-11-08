import { randomUUID } from 'node:crypto';
import { AppError, DIRECT_SCOPE, UNUSABLE_REFRESH_CODES, checkAbort, deadline } from '../core';
import { listenForOAuth } from './callback';
import { authorizeUrl, newAttempt, type OAuthClient, type Registration } from './oauth';
import type { AccountStore } from './store';

export interface AccountSummary { clientId: string; label: string; signedIn: boolean; enabled: boolean }
export interface Snapshot { epoch: string; active?: string; accounts: AccountSummary[] }
export interface Credentials { access: string; clientId: string; epoch: string }
export interface OAuthService {
  exchange: OAuthClient['exchange']; refresh: OAuthClient['refresh']; revoke: OAuthClient['revoke'];
}
export class AccountManager {
  private lifecycle = new AbortController();
  private loginAbort: AbortController | undefined;
  private lastEpoch: string | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly store: AccountStore, private readonly oauth: OAuthService, private readonly now = () => Date.now()) {}
  get signal(): AbortSignal { return this.lifecycle.signal; }
  onChange(listener: () => void): { dispose(): void } { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  private invalidate(): void { this.lifecycle.abort(); this.lifecycle = new AbortController(); this.loginAbort?.abort(); }
  private changed(epoch: string): void {
    this.lastEpoch = epoch; this.invalidate(); for (const listener of this.listeners) listener();
  }
  async snapshot(signal: AbortSignal): Promise<Snapshot> {
    return this.store.transact(state => ({ epoch: state.epoch, ...(state.active ? { active: state.active } : {}),
      accounts: state.registrations.map(reg => ({ clientId: reg.clientId,
        label: `${reg.email ?? 'ChatGPT account'} · ${reg.clientId.slice(-8)}`, signedIn: !!reg.tokens,
        enabled: reg.tokens?.scopes.includes(DIRECT_SCOPE) ?? false })) }), signal);
  }
  async synchronize(signal: AbortSignal): Promise<void> {
    const snapshot = await this.snapshot(signal);
    if (this.lastEpoch !== undefined && this.lastEpoch !== snapshot.epoch) this.changed(snapshot.epoch);
    else this.lastEpoch = snapshot.epoch;
  }
  async login(openUrl: (url: string) => Promise<void>, signal: AbortSignal, selectedClientId?: string): Promise<void> {
    this.invalidate();
    const loginAbort = new AbortController(); this.loginAbort = loginAbort;
    const operation = deadline(5 * 60000, [signal, loginAbort.signal]);
    try {
      const saved = await this.store.transact(state => ({ hostId: state.hostId, epoch: state.epoch,
        previous: selectedClientId ? structuredClone(state.registrations.find(reg => reg.clientId === selectedClientId)) : undefined }), operation.signal);
      if (selectedClientId && !saved.previous) throw new AppError('The selected account registration no longer exists.', 'auth');
      const attempt = newAttempt();
      const callback = await listenForOAuth(attempt.state, operation.signal, saved.previous?.clientId);
      let result;
      try {
        await openUrl(authorizeUrl(attempt, saved.hostId, callback.redirectUri, saved.previous));
        result = await callback.result;
      } finally { await callback.close(); }
      const registration = await this.oauth.exchange(result.code, result.clientId, callback.redirectUri, attempt, operation.signal, saved.previous);
      const epoch = await this.store.transact(state => {
        checkAbort(operation.signal);
        if (state.epoch !== saved.epoch) throw new AppError('Account state changed during sign-in. Please try again.', 'cancelled');
        const index = state.registrations.findIndex(reg => reg.clientId === registration.clientId);
        if (index >= 0 && state.registrations[index]!.subject !== registration.subject) throw new AppError('Account identity mismatch. The existing account has not been overwritten.', 'auth');
        if (index >= 0) state.registrations[index] = registration; else state.registrations.push(registration);
        state.active = registration.clientId; state.epoch = randomUUID(); return state.epoch;
      }, operation.signal);
      this.loginAbort = undefined; this.changed(epoch);
    } finally {
      operation.dispose(); if (this.loginAbort === loginAbort) this.loginAbort = undefined;
    }
  }
  async select(clientId: string, signal: AbortSignal): Promise<void> {
    this.invalidate(); const operation = deadline(45000, [signal, this.signal]);
    try {
      const epoch = await this.store.transact(state => {
        if (!state.registrations.some(reg => reg.clientId === clientId && reg.tokens)) throw new AppError('Sign in to this account again first.', 'auth');
        state.active = clientId; state.epoch = randomUUID(); return state.epoch;
      }, operation.signal);
      this.changed(epoch);
    } finally { operation.dispose(); }
  }
  async signOut(signal: AbortSignal): Promise<boolean> {
    this.invalidate(); const operation = deadline(45000, [signal, this.signal]);
    try {
      const result = await this.store.transact(async (state, lockedSignal) => {
        const active = state.registrations.find(reg => reg.clientId === state.active);
        const revokeDeadline = deadline(8000, [lockedSignal]);
        let revoked = !active;
        try { if (active) revoked = await this.oauth.revoke(active, revokeDeadline.signal); }
        catch { revoked = false; }
        finally { revokeDeadline.dispose(); }
        // Remote revocation failure must never prevent clearing local tokens.
        if (active) delete active.tokens;
        delete state.active; state.epoch = randomUUID(); return { revoked, epoch: state.epoch };
      }, operation.signal);
      this.changed(result.epoch); return result.revoked;
    } finally { operation.dispose(); }
  }
  async credentials(signal: AbortSignal): Promise<Credentials> {
    const operation = deadline(45000, [signal, this.signal]);
    try {
      const result = await this.store.transact(async (state, lockedSignal): Promise<Credentials | { error: AppError; epoch: string }> => {
        const index = state.registrations.findIndex(reg => reg.clientId === state.active);
        let registration: Registration | undefined = state.registrations[index];
        if (!registration?.tokens) throw new AppError('Run Continue with ChatGPT to sign in first.', 'auth');
        if (registration.tokens.expiresAt <= this.now() + 180000) {
          try {
            registration = await this.oauth.refresh(structuredClone(registration), lockedSignal);
            checkAbort(lockedSignal); state.registrations[index] = registration;
          } catch (error) {
            checkAbort(lockedSignal);
            if (error instanceof AppError && error.code && UNUSABLE_REFRESH_CODES.has(error.code)) {
              delete state.registrations[index]!.tokens; state.epoch = randomUUID();
              return { error: new AppError('Your sign-in has expired or been revoked. Reconnect this account.', 'auth'), epoch: state.epoch };
            }
            throw error;
          }
        }
        if (!registration.tokens?.scopes.includes(DIRECT_SCOPE)) return { error: new AppError('This account has not granted ChatGPT subscription access. Reauthorize it in Manage Accounts.', 'permission'), epoch: state.epoch };
        return { access: registration.tokens.access, clientId: registration.clientId, epoch: state.epoch };
      }, operation.signal);
      if ('error' in result) { this.changed(result.epoch); throw result.error; }
      return result;
    } finally { operation.dispose(); }
  }
  dispose(): void { this.lifecycle.abort(); this.loginAbort?.abort(); this.listeners.clear(); }
}
