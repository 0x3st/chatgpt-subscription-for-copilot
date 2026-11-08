import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { AccountManager } from '../src/auth/accounts';
import { complete, type TokenUsage } from '../src/chat/client';
import { prepareRequest } from '../src/chat/request';
import { API } from '../src/core';
import { HttpClient } from '../src/http';
import { ChatGPTProvider } from '../src/provider';
import { copilotUsagePart } from '../src/vscodeAdapter';
import { MemoryStore, fake, json, oauth, registration, signal, sse } from './helpers';

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
const options = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const message: vscode.LanguageModelChatRequestMessage = { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelTextPart('Hello')] };
const decode = (part: vscode.LanguageModelDataPart) => JSON.parse(new TextDecoder().decode(part.data)) as Record<string, unknown>;
const model = { id: 'test', name: 'Test', inputTokens: 32000, outputTokens: 4096, images: false, tools: true, efforts: [], estimatedLimits: false };

test('Responses usage is mapped to the non-public Copilot usage MIME using real counts, including cached input', () => {
  const part = copilotUsagePart({ inputTokens: 12000, outputTokens: 800, cachedInputTokens: 4000 });
  assert.ok(part instanceof vscode.LanguageModelDataPart); assert.equal(part.mimeType, 'usage');
  assert.deepEqual(decode(part), { prompt_tokens: 12000, completion_tokens: 800, total_tokens: 12800, prompt_tokens_details: { cached_tokens: 4000 } });
  // Cached input is part of the full context, not subtracted from it.
  assert.equal(decode(part).prompt_tokens, 12000);
  const zero = copilotUsagePart({ inputTokens: 0, outputTokens: 0 }); assert.ok(zero);
  assert.deepEqual(decode(zero), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('missing, malformed, fractional, negative and overflowing counts never produce fabricated zero usage', () => {
  for (const input of [undefined, null, '12', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(copilotUsagePart({ inputTokens: input, outputTokens: 10 } as TokenUsage), undefined);
    assert.equal(copilotUsagePart({ inputTokens: 10, outputTokens: input } as TokenUsage), undefined);
  }
  assert.equal(copilotUsagePart({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), undefined);
  for (const cached of [undefined, -1, 101, NaN, 1.5]) {
    const part = copilotUsagePart({ inputTokens: 100, outputTokens: 10, cachedInputTokens: cached } as TokenUsage); assert.ok(part);
    assert.deepEqual(decode(part), { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  }
});

test('the client preserves valid Responses input/output/cached counts and drops invalid cached metadata only', async () => {
  const prepared = prepareRequest(model, [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], [], false, undefined, false, 'test');
  for (const cached of [0, 20, 40, 41, -1, 1.2, '20', null]) {
    const http = new HttpClient(fake(() => sse([{ type: 'response.completed', response: { status: 'completed', output: [],
      usage: { input_tokens: 40, output_tokens: 5, input_tokens_details: { cached_tokens: cached } } } }])));
    const result = await complete(http, 'synthetic', prepared, signal(), () => undefined, 1000);
    assert.equal(result.inputTokens, 40); assert.equal(result.outputTokens, 5);
    assert.equal(result.cachedInputTokens, typeof cached === 'number' && Number.isSafeInteger(cached) && cached >= 0 && cached <= 40 ? cached : undefined);
  }
});

async function providerFixture(events: unknown[], run: (provider: ChatGPTProvider, info: vscode.LanguageModelChatInformation) => Promise<void>) {
  const accounts = new AccountManager(new MemoryStore([registration()]), oauth());
  const http = new HttpClient(fake(url => url === `${API}/models` ? json({ models: [{ slug: 'test', visibility: 'list' }] }) : sse(events)));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try { const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info); await run(provider, info); }
  finally { provider.dispose(); accounts.dispose(); }
}

test('successful provider streaming reports usage once after text, without rendering metadata as chat text', async () => {
  await providerFixture([{ type: 'response.output_text.delta', delta: 'Hi' },
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 3000, output_tokens: 25 } } }], async (provider, info) => {
    const parts: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(info, [message], options, { report: part => parts.push(part) }, token);
    assert.equal(parts.length, 2); assert.ok(parts[0] instanceof vscode.LanguageModelTextPart); assert.equal(parts[0].value, 'Hi');
    assert.ok(parts[1] instanceof vscode.LanguageModelDataPart); assert.equal(parts[1].mimeType, 'usage');
    assert.deepEqual(decode(parts[1]), { prompt_tokens: 3000, completion_tokens: 25, total_tokens: 3025 });
  });
});

test('successful responses without complete usage do not report an invented usage part', async () => {
  for (const usage of [undefined, {}, { input_tokens: 10 }, { input_tokens: 10, output_tokens: -1 }]) {
    await providerFixture([{ type: 'response.completed', response: { status: 'completed', output: [], usage } }], async (provider, info) => {
      const parts: vscode.LanguageModelResponsePart[] = [];
      await provider.provideLanguageModelChatResponse(info, [message], options, { report: part => parts.push(part) }, token);
      assert.deepEqual(parts, []);
    });
  }
});

test('failed, incomplete and truncated streams never emit successful usage', async () => {
  for (const events of [[{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' }, usage: { input_tokens: 10, output_tokens: 5 } } }],
    [{ type: 'response.incomplete', response: { usage: { input_tokens: 10, output_tokens: 5 } } }], [{ type: 'response.output_text.delta', delta: 'partial' }]]) {
    await providerFixture(events, async (provider, info) => {
      const parts: vscode.LanguageModelResponsePart[] = [];
      await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report: part => parts.push(part) }, token));
      assert.equal(parts.some(part => part instanceof vscode.LanguageModelDataPart), false);
    });
  }
});

test('cancellation after a text delta prevents terminal usage from reaching Copilot', async () => {
  await providerFixture([{ type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5 } } }], async (provider, info) => {
    const changes = new vscode.EventEmitter<void>(); let cancelled = false;
    const cancelToken: vscode.CancellationToken = { get isCancellationRequested() { return cancelled; }, onCancellationRequested: changes.event };
    const parts: vscode.LanguageModelResponsePart[] = [];
    try {
      await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report: part => {
        parts.push(part); cancelled = true; changes.fire();
      } }, cancelToken), { name: 'Canceled' });
      assert.equal(parts.length, 1); assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);
    } finally { changes.dispose(); }
  });
});
