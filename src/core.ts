export const API = 'https://api.openai.com/v1';
export const ISSUER = 'https://auth.openai.com';
export const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
export const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
export const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
export const USAGE = 'https://chatgpt.com/settings/usage';
export const APP_NAME = 'ChatGPT Subscription for Copilot';
export type Fetcher = typeof globalThis.fetch;
export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export type ErrorKind = 'auth' | 'permission' | 'quota' | 'network' | 'protocol' | 'cancelled' | 'busy';
export class AppError extends Error {
  constructor(message: string, readonly kind: ErrorKind = 'protocol', readonly status?: number,
    readonly code?: string, readonly requestId?: string, readonly bodyShape?: string) {
    super(message); this.name = 'AppError';
  }
}
export function cancelled(): AppError { return new AppError('The operation was cancelled or exceeded its total time limit.', 'cancelled'); }
const expiries = new WeakMap<AbortSignal, number>();
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted || Date.now() >= (expiries.get(signal) ?? Infinity)) throw cancelled();
}
export function deadline(ms: number, signals: readonly AbortSignal[] = []): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const expiresAt = Math.min(Date.now() + ms, ...signals.map(signal => expiries.get(signal) ?? Infinity));
  expiries.set(controller.signal, expiresAt);
  const timer = setTimeout(abort, Math.max(0, expiresAt - Date.now())); timer.unref();
  for (const signal of signals) {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }
  return { signal: controller.signal, dispose() {
    clearTimeout(timer); controller.abort();
    for (const signal of signals) signal.removeEventListener('abort', abort);
  } };
}
export function safeError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError('The operation failed. Check your connection or reconnect your account.', 'network');
}
export const UNUSABLE_REFRESH_CODES = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused'
]);
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
}
export function apiError(status: number, body: unknown, requestId?: string): AppError {
  const object = record(body); const error = record(object?.error);
  const code = identifier(error?.code ?? object?.error ?? object?.code);
  const request = identifier(requestId);
  let kind: ErrorKind = status === 401 ? 'auth' : status === 403 ? 'permission' : status === 429 ? 'quota' : 'network';
  let message = status === 200 ? 'OpenAI returned an error despite successful HTTP headers (HTTP 200).' : `OpenAI request failed (HTTP ${status}).`;
  if (status === 400) { kind = 'protocol'; message += ' The selected model or subscription route does not support this request.'; }
  if (kind === 'auth') message += ' Check your account authorization and sign in again if needed.';
  if (kind === 'permission') message += ' Your account, workspace, region, or permissions do not allow access. Do not repeatedly retry.';
  if (kind === 'quota') message += ' A subscription or application usage limit has been reached. Check ChatGPT Usage.';
  if (status >= 500) message += ' The service is temporarily unavailable. Try again later; your credentials have not been cleared.';
  // SSE errors arrive after successful HTTP headers. Classify known codes independently
  // of transport status, without trusting or exposing the service's free-form message.
  const known: Record<string, { kind: ErrorKind; message: string }> = {
    rate_limit_exceeded: { kind: 'quota', message: 'OpenAI reported a rate limit. Pause requests and try again later.' },
    insufficient_quota: { kind: 'quota', message: 'OpenAI reported insufficient quota for this request. Check ChatGPT Usage and the active account/workspace.' },
    context_length_exceeded: { kind: 'protocol', message: 'OpenAI rejected the conversation because it exceeds the model context limit. Compact the conversation or start a new chat. No history was silently dropped.' },
    invalid_prompt: { kind: 'protocol', message: 'OpenAI rejected the supplied prompt. Change the request before retrying.' },
    subscription_sharing_usage_limit_exceeded: { kind: 'quota', message: 'OpenAI reported a subscription-sharing usage limit. An app-specific limit can apply; this does not establish that your entire ChatGPT plan is exhausted. Check ChatGPT Usage and the active account/workspace.' },
    subscription_sharing_user_not_eligible: { kind: 'permission', message: 'This account or workspace is not eligible for subscription sharing.' },
    subscription_sharing_route_not_supported: { kind: 'permission', message: 'This subscription route is not supported. Do not retry the same route or switch billing methods.' },
    subscription_sharing_unsupported_capability: { kind: 'protocol', message: 'This subscription route does not support the requested capability. Adjust the model or tools.' },
    subscription_sharing_invalid_user: { kind: 'auth', message: 'The subscription identity could not be verified. Check your authorization.' },
    subscription_sharing_usage_unavailable: { kind: 'network', message: 'Subscription usage is temporarily unavailable. This is not confirmation that a usage limit was reached. Try again later.' }
  };
  if (code && Object.hasOwn(known, code)) ({ kind, message } = known[code]!);
  if (code) message += ` Error code: ${code}.`;
  if (request) message += ` Request ID: ${request}.`;
  return new AppError(message, kind, status, code, request, error ? 'error' : object?.detail !== undefined ? 'detail' : 'other');
}
