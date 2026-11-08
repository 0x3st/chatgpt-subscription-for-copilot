import { createHash, randomBytes } from 'node:crypto';
import { APP_NAME, API, AppError, AUTHORIZE, DIRECT_SCOPE, SCOPES, TOKEN, record, text } from '../core';
import type { HttpClient } from '../http';
import { OpenId, type Identity } from './oidc';

export interface Tokens { access: string; refresh: string; id: string; expiresAt: number; scopes: string[] }
export interface Registration extends Identity { clientId: string; tokens?: Tokens }
export interface LoginAttempt { state: string; nonce: string; verifier: string }
export function newAttempt(): LoginAttempt {
  const random = () => randomBytes(32).toString('base64url');
  return { state: random(), nonce: random(), verifier: random() };
}
export function authorizeUrl(attempt: LoginAttempt, hostId: string, redirectUri: string, previous?: Registration): string {
  const url = new URL(AUTHORIZE);
  const params = new URLSearchParams({
    client_id: previous?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: redirectUri, resource: API, scope: SCOPES,
    state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url')
  });
  if (!previous) params.set('agent_name_hint', APP_NAME);
  if (previous?.tokens?.id) params.set('id_token_hint', previous.tokens.id);
  if (previous?.email) params.set('login_hint', previous.email);
  if (previous?.tokens && !previous.tokens.scopes.includes(DIRECT_SCOPE)) params.set('prompt', 'consent');
  url.search = params.toString(); return url.toString();
}
function tokenString(value: unknown): string {
  const string = text(value);
  if (!string || string.length > 100000) throw new AppError('The token response is missing a required field.', 'auth');
  return string;
}
export class OAuthClient {
  readonly oidc: OpenId;
  constructor(private readonly http: HttpClient, private readonly now = () => Date.now()) { this.oidc = new OpenId(http); }
  private parseTokens(payload: unknown, previous?: Tokens): Tokens {
    const data = record(payload);
    if (!data || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      data.expires_in > 365 * 86400 || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') {
      throw new AppError('Invalid token response format.', 'auth');
    }
    const scopes = typeof data.scope === 'string' ? [...new Set(data.scope.trim().split(/\s+/).filter(Boolean))] : previous?.scopes;
    if (!scopes) throw new AppError('The token response is missing its authorization scope.', 'auth');
    return { access: tokenString(data.access_token), refresh: tokenString(data.refresh_token ?? previous?.refresh),
      id: tokenString(data.id_token ?? previous?.id), expiresAt: this.now() + data.expires_in * 1000, scopes };
  }
  async exchange(code: string, clientId: string, redirectUri: string, attempt: LoginAttempt, signal: AbortSignal, previous?: Registration): Promise<Registration> {
    const payload = await this.http.form(TOKEN, new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier,
      redirect_uri: redirectUri, resource: API
    }), signal);
    const tokens = this.parseTokens(payload);
    const identity = await this.oidc.verify(tokens.id, clientId, signal, { nonce: attempt.nonce,
      ...(previous ? { subject: previous.subject } : {}) });
    return { ...identity, clientId, tokens };
  }
  async refresh(registration: Registration, signal: AbortSignal): Promise<Registration> {
    if (!registration.tokens) throw new AppError('Sign in to the selected account again.', 'auth');
    const payload = await this.http.form(TOKEN, new URLSearchParams({ grant_type: 'refresh_token',
      client_id: registration.clientId, refresh_token: registration.tokens.refresh, resource: API }), signal);
    const tokens = this.parseTokens(payload, registration.tokens);
    const data = record(payload)!;
    const identity = data.id_token === undefined ? registration : await this.oidc.verify(tokens.id, registration.clientId, signal, { subject: registration.subject });
    return { issuer: identity.issuer, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}), clientId: registration.clientId, tokens };
  }
  async revoke(registration: Registration, signal: AbortSignal): Promise<boolean> {
    if (!registration.tokens) return true;
    try {
      const metadata = await this.oidc.metadata(signal);
      await this.http.revoke(metadata.revoke, new URLSearchParams({ token: registration.tokens.refresh,
        token_type_hint: 'refresh_token', client_id: registration.clientId }), signal);
      return true;
    } catch { return false; }
  }
}
