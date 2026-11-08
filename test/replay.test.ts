import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplayCache, collectReplay } from '../src/chat/replay';
import { wireToolName, type Prepared } from '../src/chat/request';
const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-ciphertext', summary: [{ type: 'summary_text', text: 'Summary' }] };
const call = { type: 'function_call', call_id: 'call_1', name: wireToolName('edit'), arguments: '{ "path": "a.ts" }' };
const history = (): Prepared => ({ body: { input: [{ ...call, arguments: '{"path":"a.ts"}' }, { type: 'function_call_output', call_id: 'call_1', output: 'done' }] }, allowed: new Map() });
test('server encrypted reasoning is grouped with its following function call', () => {
  const groups = collectReplay([reasoning, { type: 'message', content: [] }, call]);
  assert.equal(groups.length, 1); assert.equal(groups[0]!.callId, 'call_1'); assert.equal(groups[0]!.items[0]!.encrypted_content, 'opaque-ciphertext');
});
test('reasoning without encrypted context is not replayed as a server-only reference', () => {
  assert.deepEqual(collectReplay([{ type: 'reasoning', id: 'rs_1', summary: [] }, call]), []);
});
test('encrypted context is inserted before the matching historical call with tool results preserved', () => {
  const cache = new ReplayCache(); cache.remember('account-A:model-A', collectReplay([reasoning, call]));
  const prepared = cache.apply('account-A:model-A', history()); const input = prepared.body.input as Record<string, unknown>[];
  assert.deepEqual(input.map(item => item.type), ['reasoning', 'function_call', 'function_call_output']); assert.equal(input[2]!.output, 'done');
  assert.equal((history().body.input as unknown[]).length, 2);
});
test('encrypted context never crosses account or model boundaries or edited calls', () => {
  const cache = new ReplayCache(); cache.remember('account-A:model-A', collectReplay([reasoning, call]));
  assert.equal((cache.apply('account-B:model-A', history()).body.input as unknown[]).length, 2);
  const edited = history(); (edited.body.input as Record<string, unknown>[])[0]!.arguments = '{"path":"other.ts"}';
  assert.equal((cache.apply('account-A:model-A', edited).body.input as unknown[]).length, 2);
});
test('scope and call-ID separators cannot cause cross-model cache collisions', () => {
  const cache = new ReplayCache(); cache.remember('account:model:variant', collectReplay([reasoning, call]));
  const crafted = history(); (crafted.body.input as Record<string, unknown>[])[0]!.call_id = 'variant:call_1';
  assert.equal((cache.apply('account:model', crafted).body.input as unknown[]).length, 2);
});
test('encrypted reasoning cache expires and is cleared on disposal', () => {
  let now = 0; const cache = new ReplayCache(() => now); cache.remember('scope', collectReplay([reasoning, call])); now = 31 * 60000;
  assert.equal((cache.apply('scope', history()).body.input as unknown[]).length, 2);
  cache.clear(); assert.equal((cache.apply('scope', history()).body.input as unknown[]).length, 2);
});
