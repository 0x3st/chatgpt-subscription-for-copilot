import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { AccountManager } from '../src/auth/accounts';
import { API } from '../src/core';
import { HttpClient } from '../src/http';
import { ChatGPTProvider } from '../src/provider';
import { wireToolName } from '../src/chat/request';
import { configuration } from './vscode.mock';
import { MemoryStore, fake, json, oauth, registration, sse } from './helpers';

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const options = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const message: vscode.LanguageModelChatRequestMessage = { role: vscode.LanguageModelChatMessageRole.User, name: undefined,
  content: [new vscode.LanguageModelTextPart(String.raw`Explain \(x\); keep this request unchanged.`)] };
const completed = { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 10 } } };
const delta = (value: string, summary = false) => ({ type: summary ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta', delta: value });
const text = (parts: vscode.LanguageModelResponsePart[]) => parts.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('');

async function fixture(events: unknown[], run: (provider: ChatGPTProvider, model: vscode.LanguageModelChatInformation, bodies: Record<string, unknown>[], logs: string[]) => Promise<void>) {
  const accounts = new AccountManager(new MemoryStore([registration()]), oauth());
  const bodies: Record<string, unknown>[] = []; const logs: string[] = [];
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) return json({ models: [{ slug: 'test', visibility: 'list' }] });
    assert.equal(url, `${API}/responses`); bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>); return sse(events);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, { info: (value: string) => logs.push(value), warn: (value: string) => logs.push(value) } as unknown as vscode.LogOutputChannel);
  try {
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    await run(provider, models[0]!, bodies, logs);
  } finally { provider.dispose(); accounts.dispose(); }
}

test('Copilot receives native math from split TeX deltas, without changing inputs, tools or usage', async () => {
  const source = String.raw`\(x^2\)`;
  const call = { type: 'function_call', status: 'completed', namespace: 'copilot', call_id: 'call-1', name: wireToolName('edit'), arguments: JSON.stringify({ source }) };
  await fixture([...Array.from(String.raw`Formula \(x^2\).` + '\n```tex\n' + source + '\n```\n' + String.raw`\[\frac{1}{2}\]`, char => delta(char)),
    { ...completed, response: { ...completed.response, output: [call] } }], async (provider, model, bodies, logs) => {
    const parts: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(model, [message], { ...options, tools: [{ name: 'edit', description: 'edit', inputSchema: {} }] }, { report: part => parts.push(part) }, token);
    assert.equal(text(parts), 'Formula $x^2$.\n```tex\n' + source + '\n```\n$$\n\\frac{1}{2}\n$$\n');
    assert.equal(parts.filter(part => part instanceof vscode.LanguageModelDataPart).length, 1);
    const tool = parts.at(-1); assert.ok(tool instanceof vscode.LanguageModelToolCallPart); assert.deepEqual(tool.input, { source });
    assert.match(String(bodies[0]!.instructions), /\$\.\.\.\$ for inline math/);
    assert.match(JSON.stringify(bodies[0]!.input), /Explain/);
    assert.equal(((bodies[0]!.input as { content: { text: string }[] }[])[0]!.content[0]!.text), (message.content[0] as vscode.LanguageModelTextPart).value);
    assert.ok(!logs.join('\n').includes('x^2')); assert.ok(!logs.join('\n').includes('Explain'));
  });
});

test('summary and answer formatting are isolated; a new response has fresh code/math state', async () => {
  configuration.showReasoningSummary = { globalValue: true };
  try {
    await fixture([delta('Summary \\(unfinished', true), delta('Answer \\(x\\)\n```'), completed], async (provider, model) => {
      for (let turn = 0; turn < 2; turn++) {
        const parts: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(model, [message], options, { report: part => parts.push(part) }, token);
        assert.equal(text(parts), '\n\n**Reasoning summary**\n\nSummary \\(unfinished\n\n---\n\nAnswer $x$\n```');
      }
    });
  } finally { delete configuration.showReasoningSummary; }
});

test('disabled summaries cannot contaminate answer math state', async () => {
  await fixture([delta('```\\(ignored', true), delta('\\(answer\\)'), completed], async (provider, model) => {
    const parts: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(model, [message], options, { report: part => parts.push(part) }, token);
    assert.equal(text(parts), '$answer$');
  });
});

test('a failed stream preserves an incomplete formula literally without usage or tool handoff', async () => {
  await fixture([delta('Partial \\(x'), { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }], async (provider, model) => {
    const parts: vscode.LanguageModelResponsePart[] = [];
    await assert.rejects(provider.provideLanguageModelChatResponse(model, [message], options, { report: part => parts.push(part) }, token), { name: 'Blocked' });
    assert.equal(text(parts), 'Partial \\(x');
    assert.ok(parts.every(part => part instanceof vscode.LanguageModelTextPart));
  });
});

test('cancellation while flushing a summary prevents answer headers and text', async () => {
  configuration.showReasoningSummary = { globalValue: true };
  try {
    await fixture([delta('\\(unfinished', true), delta('Answer \\(x\\)'), completed], async (provider, model) => {
      const changes = new vscode.EventEmitter<void>(); let cancelled = false;
      const cancelToken = { get isCancellationRequested() { return cancelled; }, onCancellationRequested: changes.event };
      const parts: vscode.LanguageModelResponsePart[] = [];
      try {
        await assert.rejects(provider.provideLanguageModelChatResponse(model, [message], options, { report: part => {
          parts.push(part);
          if (part instanceof vscode.LanguageModelTextPart && part.value === '\\(unfinished') { cancelled = true; changes.fire(); }
        } }, cancelToken), { name: 'Canceled' });
        assert.equal(text(parts), '\n\n**Reasoning summary**\n\n\\(unfinished'); assert.equal(parts.length, 2);
      } finally { changes.dispose(); }
    });
  } finally { delete configuration.showReasoningSummary; }
});

test('cancellation does not flush buffered formulas after the last allowed progress report', async () => {
  await fixture([delta('Before \\(unfinished'), completed], async (provider, model) => {
    const changes = new vscode.EventEmitter<void>(); let cancelled = false;
    const cancelToken = { get isCancellationRequested() { return cancelled; }, onCancellationRequested: changes.event };
    const parts: vscode.LanguageModelResponsePart[] = [];
    try {
      await assert.rejects(provider.provideLanguageModelChatResponse(model, [message], options, { report: part => {
        parts.push(part); cancelled = true; changes.fire();
      } }, cancelToken), { name: 'Canceled' });
      assert.equal(text(parts), 'Before '); assert.equal(parts.length, 1);
    } finally { changes.dispose(); }
  });
});
