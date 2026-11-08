import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API, AppError, ISSUER, TOKEN, apiError, checkAbort, deadline, safeError } from '../src/core';
import { HttpClient, authMetadataUrl, readLimited } from '../src/http';
import { fake, json, signal } from './helpers';

test('fixed request allowlist rejects arbitrary hosts, HTTP and near matches before fetch', async () => {
  let count = 0; const http = new HttpClient(fake(() => { count++; return json({}); }));
  for (const url of ['https://evil.test/responses', 'http://api.openai.com/v1/responses', `${API}/responses/`, `${API}/responses?x=y`]) {
    await assert.rejects(http.json(url, signal()), AppError);
  }
  assert.equal(count, 0);
});
test('metadata URLs are HTTPS and exact official origin only', () => {
  assert.equal(authMetadataUrl(`${ISSUER}/.well-known/jwks.json`), `${ISSUER}/.well-known/jwks.json`);
  for (const url of ['https://auth.openai.com.evil.test/jwks', 'http://auth.openai.com/jwks', 'https://me@auth.openai.com/jwks', `${ISSUER}/jwks?x=1`]) assert.throws(() => authMetadataUrl(url));
});
test('fetch always rejects redirects and supplies an AbortSignal', async () => {
  const http = new HttpClient(fake((_url, init) => { assert.equal(init.redirect, 'error'); assert.ok(init.signal); return json({ ok: true }); }));
  assert.deepEqual(await http.json(`${API}/models`, signal()), { ok: true });
});
test('raw upstream error text and tokens never appear in user errors', async () => {
  const http = new HttpClient(fake(() => json({ error: { message: 'secret-token-and-prompt', code: 'invalid_grant' } }, 400, { 'x-request-id': 'req-123' })));
  await assert.rejects(http.json(TOKEN, signal()), (error: unknown) => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'invalid_grant'); assert.equal(error.requestId, 'req-123');
    assert.equal(error.status, 400); assert.ok(!error.message.includes('secret-token')); return true;
  });
});
test('HTML errors are not echoed and preserve HTTP status', async () => {
  const http = new HttpClient(fake(() => new Response('<script>secret</script>', { status: 503 })));
  await assert.rejects(http.json(`${API}/models`, signal()), (e: unknown) => e instanceof AppError && e.status === 503 && !e.message.includes('script'));
});
test('malformed JSON fails closed', async () => {
  const http = new HttpClient(fake(() => new Response('not-json')));
  await assert.rejects(http.json(`${API}/models`, signal()), /invalid JSON/);
});
test('response body limit is enforced', async () => { await assert.rejects(readLimited(new Response('12345'), 4), /size limit/); });
test('pre-cancelled operations never call fetch', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const http = new HttpClient(fake(() => { calls++; return json({}); }));
  await assert.rejects(http.json(`${API}/models`, controller.signal), (e: unknown) => e instanceof AppError && e.kind === 'cancelled'); assert.equal(calls, 0);
});
test('timeout bounds authentication and a stalled response body, without retries', async () => {
  let calls = 0;
  const http = new HttpClient(fake((_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const alive = setTimeout(() => reject(new Error('should not wait this long')), 1000);
      init.signal!.addEventListener('abort', () => { clearTimeout(alive); reject(new Error('aborted')); }, { once: true });
    });
  }), 15);
  await assert.rejects(http.form(TOKEN, new URLSearchParams(), signal()), (e: unknown) => e instanceof AppError && e.kind === 'cancelled'); assert.equal(calls, 1);
});
test('total timeout also covers a stalled response body after headers', async () => {
  let cancelledBody = false;
  const http = new HttpClient(fake((_url, init) => {
    let alive: ReturnType<typeof setTimeout>;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      alive = setTimeout(() => controller.error(new Error('too late')), 1000);
      init.signal!.addEventListener('abort', () => { clearTimeout(alive); cancelledBody = true; controller.error(new Error('aborted')); }, { once: true });
    } });
    return new Response(body);
  }), 15);
  await assert.rejects(http.json(`${API}/models`, signal()), (e: unknown) => e instanceof AppError && e.kind === 'cancelled');
  assert.equal(cancelledBody, true);
});
test('expired wall-clock deadlines are checked even before delayed timer callbacks run', () => {
  const original = Date.now; const start = Date.now(); const op = deadline(1000);
  try { Date.now = () => start + 2000; assert.throws(() => checkAbort(op.signal), AppError); }
  finally { Date.now = original; op.dispose(); }
});
test('quota errors inside HTTP 200 streams retain quota classification', () => {
  const error = apiError(200, { error: { code: 'subscription_sharing_usage_limit_exceeded' } });
  assert.equal(error.kind, 'quota'); assert.equal(error.status, 200);
});
test('unknown exceptions do not leak exception messages', () => { assert.ok(!safeError(new Error('secret')).message.includes('secret')); });
test('deadlines propagate cancellation and clean up', () => {
  const controller = new AbortController(); const op = deadline(1000, [controller.signal]); controller.abort(); assert.ok(op.signal.aborted); op.dispose();
});
