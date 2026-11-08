import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const load = createRequire(resolve('package.json'));
const { checkMarketplaceAuth } = load('./scripts/marketplace-auth.cjs') as {
  checkMarketplaceAuth(options: { fetchImpl: typeof fetch; environment: Record<string, string> }): Promise<void>;
};
const environment = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request-token', VSCE_MARKETPLACE_URL: 'https://untrusted.example.test' };

test('OIDC preflight uses official vsce exchange, a fixed Marketplace, finite cancellation, no redirects, and never publishes or returns credentials', async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url)); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    if (urls.length === 1) {
      assert.equal(new URL(String(url)).searchParams.get('audience'), 'marketplace.visualstudio.com');
      return new Response(JSON.stringify({ value: 'synthetic-oidc-token' }));
    }
    assert.equal(String(url), 'https://marketplace.visualstudio.com/_apis/gallery/token?api-version=7.2-preview.1');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'FederatedToken synthetic-oidc-token');
    assert.deepEqual(JSON.parse(String(init?.body)), { publisherName: 'lab530' });
    return new Response(JSON.stringify({ credential: 'synthetic-exchanged-credential' }));
  };
  assert.equal(await checkMarketplaceAuth({ fetchImpl, environment }), undefined);
  assert.equal(urls.length, 2);
});

test('OIDC preflight failures reveal only status, never upstream details or credentials, and never use PAT fallback', async () => {
  let count = 0;
  await assert.rejects(checkMarketplaceAuth({ environment, fetchImpl: async () => {
    count++; return new Response(JSON.stringify({ message: 'SENSITIVE upstream response synthetic-secret' }), { status: 403 });
  } }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /SENSITIVE|synthetic-secret|synthetic-request-token/); return true;
  });
  assert.equal(count, 1);
  await assert.rejects(checkMarketplaceAuth({ environment: {}, fetchImpl: async () => { throw new Error('Must not fetch'); } }), /preflight failed/);
});
