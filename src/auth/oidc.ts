import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { AppError, AUTHORIZE, DISCOVERY, ISSUER, TOKEN, record, text } from '../core';
import type { HttpClient } from '../http';

export interface Identity { issuer: string; subject: string; email?: string }
export class OpenId {
  constructor(private readonly http: HttpClient) {}
  async metadata(signal: AbortSignal): Promise<{ jwks: string; revoke: string }> {
    const config = record(await this.http.json(DISCOVERY, signal));
    if (config?.issuer !== ISSUER || config.authorization_endpoint !== AUTHORIZE || config.token_endpoint !== TOKEN) {
      throw new AppError('OpenAI authentication metadata does not match the fixed endpoints.', 'auth');
    }
    return { jwks: this.http.trustMetadataUrl(config.jwks_uri), revoke: this.http.trustMetadataUrl(config.revocation_endpoint) };
  }
  async verify(idToken: string, clientId: string, signal: AbortSignal, expected: { nonce?: string; subject?: string } = {}): Promise<Identity> {
    const metadata = await this.metadata(signal);
    const raw = record(await this.http.json(metadata.jwks, signal));
    if (!raw || !Array.isArray(raw.keys) || raw.keys.length > 100) throw new AppError('Invalid OpenAI JWKS.', 'auth');
    try {
      const jwks = createLocalJWKSet(raw as unknown as JSONWebKeySet);
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256'], clockTolerance: 5,
        requiredClaims: ['sub', 'iat', 'exp']
      });
      if (!text(payload.sub) || (expected.nonce !== undefined && payload.nonce !== expected.nonce) ||
        (expected.subject !== undefined && payload.sub !== expected.subject) ||
        (payload.azp !== undefined && payload.azp !== clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) {
        throw new Error('identity mismatch');
      }
      return { issuer: ISSUER, subject: payload.sub!, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
    } catch { throw new AppError('ID token signature or identity validation failed. The account has not been replaced.', 'auth'); }
  }
}
