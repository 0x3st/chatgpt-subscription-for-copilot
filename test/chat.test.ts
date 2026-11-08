import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API, AppError } from '../src/core';
import { HttpClient } from '../src/http';
import { complete } from '../src/chat/client';
import { editorId, parseModels, type ChatModel } from '../src/chat/models';
import { NAMESPACE, estimateTokens, prepareRequest, wireToolName, type Message } from '../src/chat/request';
import { SseParser, events } from '../src/chat/sse';
import { fake, signal, sse } from './helpers';
const model: ChatModel = { id: 'test-model', name: 'Test', images: true, tools: true, inputTokens: 32000, outputTokens: 4000, efforts: ['low', 'high'], estimatedLimits: false };
const messages: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }];
const tools = [{ name: 'edit-file', description: 'edit', schema: { type: 'object' } }];
const prepare = (required = false) => prepareRequest(model, messages, tools, required, undefined, false, 'session');
const call = (overrides = {}) => ({ type: 'function_call', status: 'completed', namespace: NAMESPACE, call_id: 'call-1', name: wireToolName('edit-file'), arguments: '{"path":"example.ts"}', ...overrides });
const terminal = (output: unknown[] = []) => ({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 20 } } });
async function run(items: unknown[], prepared = prepare()) { return complete(new HttpClient(fake(() => sse(items))), 'access', prepared, signal(), () => undefined, 1000); }

test('model catalog respects account visibility, ordering, duplicate IDs and metadata', () => {
  const models = parseModels({ models: [
    { slug: 'hidden', visibility: 'hide' }, { slug: 'first', visibility: 'list', display_name: 'First', supports_images: true, context_window: 100000, max_output_tokens: 10000, supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'first', visibility: 'list' }, { slug: 'second', visibility: 'list' }
  ] });
  assert.deepEqual(models.map(item => item.id), ['first', 'second']); assert.equal(models[0]!.images, true); assert.deepEqual(models[0]!.efforts, ['high']);
  assert.equal(models[1]!.estimatedLimits, true); assert.equal(models[1]!.images, false);
});
test('no catalog guesses or API-key model fallback on invalid or empty responses', () => {
  for (const payload of [{ data: [{ id: 'gpt-test' }] }, { models: [] }, { models: [{ slug: 'hidden', visibility: 'hide' }] }]) assert.throws(() => parseModels(payload), AppError);
});
test('editor IDs avoid vendor-prefix based custom tool profiles', () => { assert.ok(editorId('gpt-test').startsWith('chatgpt-sub-')); assert.notEqual(editorId('gpt-test'), editorId('gpt-other')); });
test('request uses namespace tools and omits unsupported preview fields', () => {
  const prepared = prepareRequest(model, messages, tools, true, 'high', true, 'session');
  assert.equal(prepared.body.store, false); assert.equal(prepared.body.stream, true); assert.equal(prepared.body.tool_choice, 'required');
  assert.deepEqual(prepared.body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal((prepared.body.tools as { type: string }[])[0]!.type, 'namespace');
  for (const key of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id', 'conversation', 'metadata', 'background']) assert.ok(!(key in prepared.body));
  assert.equal(prepared.allowed.get(wireToolName('edit-file')), 'edit-file');
});
test('tool names are deterministic, bounded, distinct and safe for arbitrary Copilot names', () => {
  const long = 'mcp.some service/tool'.repeat(20); assert.match(wireToolName(long), /^[a-z0-9_]{1,64}$/);
  assert.equal(wireToolName(long), wireToolName(long)); assert.notEqual(wireToolName('a'), wireToolName('b'));
});
test('message, call and tool-result interleaving is preserved', () => {
  const history: Message[] = [
    { role: 'assistant', parts: [{ type: 'text', text: 'before' }, { type: 'call', id: '1', name: 'edit-file', input: {} }, { type: 'text', text: 'after' }] },
    { role: 'user', parts: [{ type: 'result', id: '1', content: [{ type: 'text', text: 'done' }] }] }
  ];
  const input = prepareRequest(model, history, tools, false, undefined, false, 's').body.input as Record<string, unknown>[];
  assert.deepEqual(input.map(item => item.type), ['message', 'function_call', 'message', 'function_call_output']);
  assert.equal(input[1]!.namespace, NAMESPACE); assert.equal(input[1]!.name, wireToolName('edit-file')); assert.equal(input[3]!.output, 'done');
});
test('images and tool-result images preserve MIME and bytes rather than stringify binary', () => {
  const image = { type: 'image' as const, mime: 'image/png', data: Uint8Array.of(1, 2, 3) };
  const history: Message[] = [{ role: 'user', parts: [image, { type: 'result', id: '1', content: [{ type: 'text', text: 'screenshot' }, image] }] }];
  const serialized = JSON.stringify(prepareRequest(model, history, [], false, undefined, false, 's').body);
  assert.ok(serialized.includes('data:image/png;base64,AQID')); assert.ok(serialized.includes('screenshot'));
  assert.throws(() => prepareRequest({ ...model, images: false }, history, [], false, undefined, false, 's'), /Images have not been sent/);
});
test('unsupported effort, unavailable tools, duplicate tools and empty requests fail early', () => {
  assert.throws(() => prepareRequest(model, messages, tools, false, 'max', false, 's'), /reasoning effort/);
  assert.throws(() => prepareRequest(model, messages, [], true, undefined, false, 's'), /no tools are available/);
  assert.throws(() => prepareRequest({ ...model, tools: false }, messages, tools, false, undefined, false, 's'), /does not support tool/);
  assert.throws(() => prepareRequest(model, messages, [...tools, ...tools], false, undefined, false, 's'), /duplicate/);
  assert.throws(() => prepareRequest(model, [], [], false, undefined, false, 's'), /empty conversation/);
});
test('SSE parser handles CRLF split at every character boundary', () => {
  const input = 'event: response.output_text.delta\r\ndata: {"delta":"你好"}\r\n\r\n';
  for (let split = 0; split <= input.length; split++) {
    const parser = new SseParser(); const result = [...parser.push(input.slice(0, split)), ...parser.push(input.slice(split), true)];
    assert.deepEqual(result, [{ event: 'response.output_text.delta', data: '{"delta":"你好"}' }]);
  }
});
test('SSE multi-line data and comments are correctly processed', () => {
  const parser = new SseParser(); assert.deepEqual(parser.push(': comment\ndata: a\ndata: b\n\n'), [{ data: 'a\nb' }]);
});
test('SSE decoding survives UTF-8 split byte-by-byte', async () => {
  const bytes = new TextEncoder().encode('data: {"delta":"中文🙂"}\n\n'); let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset)); } });
  const result = []; for await (const event of events(body, signal())) result.push(event);
  assert.deepEqual(result, [{ data: '{"delta":"中文🙂"}' }]);
});
test('SSE event size is bounded', () => { const parser = new SseParser(); assert.throws(() => parser.push('data: ' + 'x'.repeat(3 * 1024 * 1024) + '\n'), /size limit/); });
test('stream sends bearer only to the fixed public endpoint, without beta headers', async () => {
  const http = new HttpClient(fake((url, init) => {
    assert.equal(url, `${API}/responses`); const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer access'); assert.equal(headers['OpenAI-Beta'], undefined); assert.equal(init.redirect, 'error');
    assert.equal(headers.Accept, 'application/json'); assert.equal(JSON.parse(String(init.body)).stream, true);
    return sse([terminal()]);
  }));
  assert.equal((await complete(http, 'access', prepare(), signal(), () => undefined, 1000)).inputTokens, 10);
});
test('Pi SDK compatible SSE parsing accepts missing or nonstandard Content-Type without weakening completion checks', async () => {
  for (const [contentType, safeType] of [[undefined, 'missing'], ['text/plain; charset=utf-8', 'text/plain'],
    ['application/json', 'application/json'], ['application/octet-stream', 'application/octet-stream'], ['application/x-PRIVATE', 'other']] as const) {
    const tool = call(); const response = sse([{ type: 'response.output_item.done', item: tool }, terminal([tool])]);
    if (contentType) response.headers.set('content-type', contentType); else response.headers.delete('content-type');
    response.headers.set('x-request-id', 'req_mime_test');
    const seen: unknown[] = [];
    const result = await complete(new HttpClient(fake(() => response)), 'access', prepare(), signal(), () => undefined, 1000, info => seen.push(info));
    assert.equal(result.tools.length, 1); assert.equal(result.tools[0]!.name, 'edit-file');
    assert.deepEqual(seen, [{ status: 200, contentType: safeType, requestId: 'req_mime_test' }]);
  }
});
test('HTTP 200 JSON error is not disguised as an upstream 502 and preserves safe subscription error codes', async () => {
  for (const [code, kind] of [['subscription_sharing_usage_limit_exceeded', 'quota'], ['subscription_sharing_invalid_user', 'auth'], ['subscription_sharing_user_not_eligible', 'permission']]) {
    const response = Response.json({ error: { code, message: 'PRIVATE response text and bearer credential' } }, { headers: { 'x-request-id': 'req_json_error' } });
    await assert.rejects(complete(new HttpClient(fake(() => response)), 'access', prepare(), signal(), () => undefined, 1000),
      (error: unknown) => error instanceof AppError && error.status === 200 && error.code === code && error.kind === kind &&
        error.bodyShape === 'json-error' && error.requestId === 'req_json_error' && error.message.includes('HTTP 200') && !error.message.includes('PRIVATE'));
  }
});
test('JSON success, HTML and plaintext are never accepted as completed SSE or tools', async () => {
  for (const response of [Response.json({ object: 'response', status: 'completed', output: [call()], private: 'PRIVATE' }),
    new Response('<html>PRIVATE login page</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('PRIVATE gateway text', { headers: { 'Content-Type': 'text/plain' } })]) {
    await assert.rejects(complete(new HttpClient(fake(() => response)), 'access', prepare(), signal(), () => undefined, 1000),
      (error: unknown) => error instanceof AppError && error.status === 200 && !error.message.includes('PRIVATE'));
  }
});
test('non-SSE diagnostics are bounded, redact header parameters, and cancel body readers', async () => {
  for (const [body, shape] of [['{"PRIVATE":', 'json-invalid'], ['{"PRIVATE":"' + 'x'.repeat(65537) + '"}', 'json-too-large'], [' '.repeat(8193), 'blank-too-large']]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
      pull(controller) { if (shape === 'json-invalid') controller.close(); }, cancel() { cancelled = true; } });
    const response = new Response(stream, { headers: { 'Content-Type': 'application/json; private=PRIVATE', 'x-request-id': 'invalid request PRIVATE' } });
    await assert.rejects(complete(new HttpClient(fake(() => response)), 'access', prepare(), signal(), () => undefined, 1000),
      (error: unknown) => error instanceof AppError && error.bodyShape === shape && !error.message.includes('PRIVATE'));
    if (shape !== 'json-invalid') assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});
test('empty HTTP response preserves actual status and has no fake completion', async () => {
  await assert.rejects(complete(new HttpClient(fake(() => new Response(null, { status: 204 }))), 'access', prepare(), signal(), () => undefined, 1000),
    (error: unknown) => error instanceof AppError && error.status === 204 && error.bodyShape === 'empty' && error.message.includes('HTTP 204'));
});
test('mislabeled SSE still rejects streamed tools if the connection is truncated', async () => {
  const response = sse([{ type: 'response.output_item.done', item: call() }]); response.headers.set('content-type', 'application/json');
  await assert.rejects(complete(new HttpClient(fake(() => response)), 'access', prepare(), signal(), () => undefined, 1000), /response.completed/);
});
test('text streams immediately, while tool calls only become available after completion', async () => {
  const output: string[] = []; const tool = call();
  const result = await complete(new HttpClient(fake(() => sse([
    { type: 'response.output_text.delta', delta: 'hello' }, { type: 'response.output_item.done', item: tool }, terminal([tool])
  ]))), 'access', prepare(), signal(), (_type, value) => output.push(value), 1000);
  assert.deepEqual(output, ['hello']); assert.equal(result.tools[0]!.name, 'edit-file'); assert.deepEqual(result.tools[0]!.input, { path: 'example.ts' });
});
test('refusal deltas are surfaced as text rather than an empty success', async () => {
  const chunks: string[] = [];
  await complete(new HttpClient(fake(() => sse([{ type: 'response.refusal.delta', delta: 'Cannot help with that.' }, terminal()]))),
    'access', prepare(), signal(), (_type, delta) => chunks.push(delta), 1000);
  assert.deepEqual(chunks, ['Cannot help with that.']);
});
test('unexpected custom or hosted tools fail closed', async () => {
  for (const type of ['custom_tool_call', 'computer_call', 'web_search_call']) await assert.rejects(run([terminal([{ type }])]), /undeclared tool type/);
});
test('tool calls can be recovered from the authoritative completed output', async () => { assert.equal((await run([terminal([call()])])).tools.length, 1); });
test('post-stream quota failure prevents all tool calls from being returned', async () => {
  await assert.rejects(run([{ type: 'response.output_item.done', item: call() },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private' } } }]),
  (e: unknown) => e instanceof AppError && e.kind === 'quota' && !e.message.includes('private'));
});
test('unknown tools, wrong namespaces, invalid JSON and non-object arguments fail closed', async () => {
  for (const tool of [call({ name: 'not-declared' }), call({ namespace: 'evil' }), call({ arguments: '{' }), call({ arguments: '[]' }), call({ arguments: 'null' })]) {
    await assert.rejects(run([terminal([tool])]), AppError);
  }
});
test('truncated streams and DONE alone cannot report success', async () => {
  await assert.rejects(run([{ type: 'response.output_item.done', item: call() }]), /completed/);
  const http = new HttpClient(fake(() => new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
  await assert.rejects(complete(http, 'access', prepare(), signal(), () => undefined, 1000), /completed/);
});
test('malformed SSE JSON and incomplete responses fail explicitly', async () => {
  await assert.rejects(run([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]), /incomplete/);
  const http = new HttpClient(fake(() => new Response('data: {broken\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
  await assert.rejects(complete(http, 'access', prepare(), signal(), () => undefined, 1000), /invalid JSON/);
});
test('malformed completed output cannot turn into a silent success', async () => {
  for (const output of [123, 'invalid', [null]]) await assert.rejects(run([{ type: 'response.completed', response: { status: 'completed', output } }]), /Invalid output list/);
});
test('conflicting tool results and missing required tool calls are not silently accepted', async () => {
  await assert.rejects(run([{ type: 'response.output_item.done', item: call() }, terminal([call({ arguments: '{}' })])]), /do not match/);
  await assert.rejects(run([terminal()], prepare(true)), /required tool call/);
});
test('token estimates account for CJK, tool arguments and tool-result images', () => {
  assert.ok(estimateTokens('中文') >= 2);
  assert.ok(estimateTokens([{ role: 'user', parts: [{ type: 'result', id: '1', content: [{ type: 'image', mime: 'image/png', data: new Uint8Array() }] }] }]) >= 2048);
});
