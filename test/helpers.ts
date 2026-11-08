import { randomUUID } from 'node:crypto';
import { AppError, DIRECT_SCOPE, ISSUER, checkAbort, type Fetcher } from '../src/core';
import type { OAuthService } from '../src/auth/accounts';
import type { Registration } from '../src/auth/oauth';
import { newVault, type AccountStore, type VaultState } from '../src/auth/store';
export const signal = () => new AbortController().signal;
export function registration(clientId = 'oaiapp_A', expired = false): Registration {
  return { issuer: ISSUER, subject: `user-${clientId}`, email: 'person@example.test', clientId,
    tokens: { access: `access-${clientId}`, refresh: `refresh-${clientId}`, id: `id-${clientId}`,
      expiresAt: Date.now() + (expired ? -1000 : 3600000), scopes: [DIRECT_SCOPE, 'resource.invoke'] } };
}
export class MemoryStore implements AccountStore {
  state: VaultState = newVault(); private queue: Promise<unknown> = Promise.resolve();
  constructor(registrations: Registration[] = []) { this.state.registrations = registrations; if (registrations[0]) this.state.active = registrations[0].clientId; }
  transact<T>(work: (state: VaultState, signal: AbortSignal) => Promise<T> | T, abort: AbortSignal): Promise<T> {
    const task = this.queue.catch(() => undefined).then(async () => {
      checkAbort(abort); const next = structuredClone(this.state); const result = await work(next, abort); checkAbort(abort);
      this.state = next; return result;
    });
    this.queue = task; return task;
  }
  switchTo(reg: Registration): void { this.state.registrations.push(reg); this.state.active = reg.clientId; this.state.epoch = randomUUID(); }
}
export function oauth(overrides: Partial<OAuthService> = {}): OAuthService {
  return { exchange: async (_code, clientId) => registration(clientId),
    refresh: async reg => ({ ...reg, tokens: { ...reg.tokens!, access: 'renewed', expiresAt: Date.now() + 3600000 } }),
    revoke: async () => true, ...overrides };
}
export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
export function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>): Fetcher {
  return async (input, init) => handler(String(input), init ?? {});
}
export function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
export const failure = (code = 'invalid_grant') => new AppError('mock token error', 'auth', 400, code);
