import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from 'jose';
import { API, AUTHORIZE, DIRECT_SCOPE, DISCOVERY, ISSUER, TOKEN } from '../src/core';
import { HttpClient } from '../src/http';
import { OAuthClient, authorizeUrl, newAttempt } from '../src/auth/oauth';
import { OpenId } from '../src/auth/oidc';
import { fake, json, registration, signal } from './helpers';
let privateKey: CryptoKey; let jwk: object;
before(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true }); privateKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
});
async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ nonce: 'nonce', email: 'person@example.test', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(typeof overrides.iss === 'string' ? overrides.iss : ISSUER).setAudience(typeof overrides.aud === 'string' ? overrides.aud : 'oaiapp_A')
    .setSubject(typeof overrides.sub === 'string' ? overrides.sub : 'user-oaiapp_A').setIssuedAt()
    .setExpirationTime(overrides.exp === undefined ? '1h' : overrides.exp as number).sign(privateKey);
}
function client(idToken: string, payload: object = {}, capture?: (body: URLSearchParams) => void): HttpClient {
  return new HttpClient(fake((url, init) => {
    if (url === DISCOVERY) return json({ issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` });
    if (url === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [jwk] });
    if (url === TOKEN) {
      capture?.(new URLSearchParams(String(init.body)));
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: idToken, expires_in: 3600,
        token_type: 'Bearer', scope: `openid resource.invoke ${DIRECT_SCOPE}`, ...payload });
    }
    if (url === `${ISSUER}/api/accounts/oauth/revoke`) return new Response('');
    throw new Error('unexpected test request');
  }));
}
test('new registration uses fresh state, nonce, PKCE S256 and a stable host ID', () => {
  const first = newAttempt(); const second = newAttempt(); assert.notEqual(first.state, second.state); assert.notEqual(first.verifier, second.verifier);
  const url = new URL(authorizeUrl(first, 'urn:uuid:test', 'http://127.0.0.1:1234/auth/callback'));
  assert.equal(url.origin + url.pathname, AUTHORIZE); assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('resource'), API); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('scope')?.includes(DIRECT_SCOPE)); assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:test');
  assert.ok(url.searchParams.get('agent_name_hint')); assert.ok(!url.searchParams.has('client_secret'));
});
test('reauthorization reuses the issued client and retained hints, not dynamic registration', () => {
  const reg = registration(); const url = new URL(authorizeUrl(newAttempt(), 'urn:uuid:test', 'http://127.0.0.1:1/auth/callback', reg));
  assert.equal(url.searchParams.get('client_id'), reg.clientId); assert.equal(url.searchParams.get('id_token_hint'), reg.tokens!.id);
  assert.equal(url.searchParams.has('agent_name_hint'), false); assert.equal(url.searchParams.has('prompt'), false);
  reg.tokens!.scopes = []; assert.equal(new URL(authorizeUrl(newAttempt(), 'urn:uuid:test', 'http://127.0.0.1:1/auth/callback', reg)).searchParams.get('prompt'), 'consent');
});
test('signed-out reauthorization keeps client ID but sends no retained ID token', () => {
  const reg = registration(); delete reg.tokens;
  const url = new URL(authorizeUrl(newAttempt(), 'urn:uuid:test', 'http://127.0.0.1:1/auth/callback', reg));
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_A'); assert.equal(url.searchParams.has('id_token_hint'), false);
});
test('ID token signature, issuer, audience, subject and nonce are validated', async () => {
  const id = await token(); const oidc = new OpenId(client(id));
  const identity = await oidc.verify(id, 'oaiapp_A', signal(), { nonce: 'nonce', subject: 'user-oaiapp_A' });
  assert.equal(identity.subject, 'user-oaiapp_A'); assert.equal(identity.email, 'person@example.test');
  await assert.rejects(oidc.verify(id, 'other-client', signal()), /validation failed/);
  await assert.rejects(oidc.verify(id, 'oaiapp_A', signal(), { nonce: 'wrong' }), /validation failed/);
  await assert.rejects(oidc.verify(id, 'oaiapp_A', signal(), { subject: 'other-user' }), /validation failed/);
  await assert.rejects(oidc.verify(await token({ iss: 'https://evil.test' }), 'oaiapp_A', signal()), /validation failed/);
  await assert.rejects(oidc.verify(await token({ exp: 1 }), 'oaiapp_A', signal()), /validation failed/);
  const parts = id.split('.'); parts[2] = 'invalid'; await assert.rejects(oidc.verify(parts.join('.'), 'oaiapp_A', signal()), /validation failed/);
});
test('OIDC discovery cannot redirect JWKS to a third party', async () => {
  const oidc = new OpenId(new HttpClient(fake(() => json({ issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN,
    jwks_uri: 'https://evil.test/key', revocation_endpoint: `${ISSUER}/revoke` }))));
  await assert.rejects(oidc.verify(await token(), 'oaiapp_A', signal()), /non-official/);
});
test('code exchange uses issued client ID and exact callback, and verifies nonce', async () => {
  const attempt = newAttempt(); attempt.nonce = 'nonce'; let form: URLSearchParams | undefined;
  const oauth = new OAuthClient(client(await token(), {}, body => { form = body; }));
  const reg = await oauth.exchange('code', 'oaiapp_A', 'http://127.0.0.1:4567/auth/callback', attempt, signal());
  assert.equal(reg.subject, 'user-oaiapp_A'); assert.equal(form?.get('client_id'), 'oaiapp_A'); assert.equal(form?.get('resource'), API);
  assert.equal(form?.get('redirect_uri'), 'http://127.0.0.1:4567/auth/callback'); assert.equal(form?.get('code_verifier'), attempt.verifier);
});
test('missing or non-Bearer token types are rejected before credentials are stored', async () => {
  for (const tokenType of [undefined, 123, 'MAC']) {
    const attempt = newAttempt(); attempt.nonce = 'nonce';
    await assert.rejects(new OAuthClient(client(await token(), { token_type: tokenType })).exchange('code', 'oaiapp_A',
      'http://127.0.0.1:1/auth/callback', attempt, signal()), /Invalid token response format/);
  }
});
test('permission decline is retained as a signed-in registration without inference permission', async () => {
  const attempt = newAttempt(); attempt.nonce = 'nonce';
  const reg = await new OAuthClient(client(await token(), { scope: 'openid profile email' })).exchange('code', 'oaiapp_A', 'http://127.0.0.1:1/auth/callback', attempt, signal());
  assert.ok(reg.tokens); assert.equal(reg.tokens.scopes.includes(DIRECT_SCOPE), false);
});
test('refresh uses issued client ID, rotates tokens and does not request a new scope', async () => {
  let form: URLSearchParams | undefined;
  const next = await new OAuthClient(client(await token(), {}, body => { form = body; })).refresh(registration(), signal());
  assert.equal(next.tokens!.refresh, 'new-refresh'); assert.equal(form?.get('client_id'), 'oaiapp_A'); assert.equal(form?.get('scope'), null);
});
test('refresh can retain omitted refresh/ID token and scope, but never accept a changed identity', async () => {
  const http = client(await token(), { refresh_token: undefined, id_token: undefined, scope: undefined });
  const next = await new OAuthClient(http).refresh(registration(), signal());
  assert.equal(next.tokens!.refresh, registration().tokens!.refresh); assert.equal(next.tokens!.id, registration().tokens!.id);
  await assert.rejects(new OAuthClient(client(await token({ sub: 'other-user' }))).refresh(registration(), signal()), /validation failed/);
});
test('revocation uses the discovered official endpoint and handles empty HTTP 200', async () => {
  assert.equal(await new OAuthClient(client(await token())).revoke(registration(), signal()), true);
});
