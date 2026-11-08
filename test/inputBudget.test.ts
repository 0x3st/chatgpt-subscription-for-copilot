import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { AccountManager } from '../src/auth/accounts';
import { API } from '../src/core';
import { HttpClient } from '../src/http';
import { ChatGPTProvider } from '../src/provider';
import { configuration } from './vscode.mock';
import { MemoryStore, fake, json, oauth, registration, signal, sse } from './helpers';

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
const options = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const message = (text: string): vscode.LanguageModelChatRequestMessage => ({ role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelTextPart(text)] });

for (const ceilingSource of ['catalog', 'saved override']) {
  test(`the ${ceilingSource} budget is enforced without native context options, including tool definitions`, async () => {
    const accounts = new AccountManager(new MemoryStore([registration()]), oauth()); const bodies: Record<string, unknown>[] = [];
    const http = new HttpClient(fake((url, init) => {
      if (url === `${API}/models`) return json({ models: [{ slug: 'test', visibility: 'list', max_input_tokens: ceilingSource === 'catalog' ? 1024 : 32000 }] });
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
    }));
    const provider = new ChatGPTProvider(accounts, http, async () => false, log);
    try {
      if (ceilingSource === 'saved override') configuration.modelOverrides = { globalValue: { test: { contextWindow: 1024 } } };
      const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info); assert.equal(info.maxInputTokens, 1024);
      await assert.rejects(provider.provideLanguageModelChatResponse(info, [message('x'.repeat(20000))], options, { report() {} }, token), /No history was dropped/);
      await assert.rejects(provider.provideLanguageModelChatResponse(info, [message('hi')], { ...options,
        tools: [{ name: 'tool', description: 'x'.repeat(20000), inputSchema: {} }] }, { report() {} }, token), /input context budget/);
      assert.equal(bodies.length, 0);
      await provider.provideLanguageModelChatResponse(info, [message('hi')], options, { report() {} }, token);
      assert.equal(bodies.length, 1); assert.match(JSON.stringify(bodies[0]!.input), /hi/);
    } finally { provider.dispose(); accounts.dispose(); delete configuration.modelOverrides; }
  });
}

test('old model information cannot bypass a smaller current-account ceiling when contextSize is absent', async () => {
  const accounts = new AccountManager(new MemoryStore([registration(), registration('oaiapp_B')]), oauth()); let sent = 0;
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) return json({ models: [{ slug: 'shared', visibility: 'list', max_input_tokens:
      new Headers(init.headers).get('Authorization')?.includes('oaiapp_B') ? 1024 : 32000 }] });
    sent++; return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const [oldInfo] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(oldInfo); assert.equal(oldInfo.maxInputTokens, 32000);
    await accounts.select('oaiapp_B', signal());
    await assert.rejects(provider.provideLanguageModelChatResponse(oldInfo, [message('x'.repeat(20000))], options, { report() {} }, token), /input context budget/);
    assert.equal(sent, 0);
  } finally { provider.dispose(); accounts.dispose(); }
});

test('lowering a saved default applies to a stale editor model even with no native context selection', async () => {
  const accounts = new AccountManager(new MemoryStore([registration()]), oauth()); let sent = 0;
  const http = new HttpClient(fake(url => {
    if (url === `${API}/models`) return json({ models: [{ slug: 'test', visibility: 'list', max_input_tokens: 32000 }] });
    sent++; return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const [oldInfo] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(oldInfo);
    configuration.modelOverrides = { globalValue: { test: { contextWindow: 1024 } } };
    await assert.rejects(provider.provideLanguageModelChatResponse(oldInfo, [message('x'.repeat(20000))], options, { report() {} }, token), /input context budget/);
    assert.equal(sent, 0);
  } finally { provider.dispose(); accounts.dispose(); delete configuration.modelOverrides; }
});
