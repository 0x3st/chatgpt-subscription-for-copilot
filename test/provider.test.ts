import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { configuration } from './vscode.mock';
import { AccountManager } from '../src/auth/accounts';
import { HttpClient } from '../src/http';
import { API } from '../src/core';
import { ChatGPTProvider, settings } from '../src/provider';
import { normalizeMessage } from '../src/vscodeAdapter';
import { wireToolName } from '../src/chat/request';
import { MemoryStore, fake, json, oauth, registration, signal, sse } from './helpers';
const uncancelled: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const message = (value: string): vscode.LanguageModelChatRequestMessage => ({ role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelTextPart(value)] });
const log = { info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
const options = { toolMode: vscode.LanguageModelChatToolMode.Auto };

test('settings ignore workspace overrides and clamp the total timeout', () => {
  configuration.reasoningEffort = { globalValue: 'high', workspaceValue: 'max' };
  configuration.showReasoningSummary = { defaultValue: false, workspaceValue: true };
  configuration.requestTimeoutSeconds = { globalValue: 999999 };
  assert.deepEqual(settings(), { effort: 'high', summary: false, timeoutMs: 1800000 });
  for (const key of Object.keys(configuration)) delete configuration[key];
});
test('silent discovery never opens the browser or makes network requests when signed out', async () => {
  let logins = 0; let requests = 0; const accounts = new AccountManager(new MemoryStore(), oauth());
  const provider = new ChatGPTProvider(accounts, new HttpClient(fake(() => { requests++; throw new Error('unexpected'); })), async () => { logins++; return false; }, log);
  try { assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, uncancelled), []); assert.equal(logins, 0); assert.equal(requests, 0); }
  finally { provider.dispose(); accounts.dispose(); }
});
test('interactive reconnect reuses the retained registration instead of creating a new client', async () => {
  const reg = registration(); delete reg.tokens; const accounts = new AccountManager(new MemoryStore([reg]), oauth());
  let selected: string | undefined;
  const provider = new ChatGPTProvider(accounts, new HttpClient(fake(() => { throw new Error('unexpected network'); })),
    async clientId => { selected = clientId; return false; }, log);
  try { assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, uncancelled), []); assert.equal(selected, reg.clientId); }
  finally { provider.dispose(); accounts.dispose(); }
});
test('Copilot model discovery, streaming, tool execution handoff and full-history replay', async () => {
  const accounts = new AccountManager(new MemoryStore([registration()]), oauth()); let turns = 0;
  const bodies: Record<string, unknown>[] = [];
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) return json({ models: [{ slug: 'test-model', display_name: 'Test', visibility: 'list', supports_images: true }] });
    assert.equal(url, `${API}/responses`); bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>); turns++;
    const call = { type: 'function_call', namespace: 'copilot', status: 'completed', call_id: 'call-1', name: wireToolName('edit'), arguments: '{"path":"example.ts"}' };
    return sse(turns === 1 ? [{ type: 'response.output_text.delta', delta: 'Editing.' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'rs_replay', encrypted_content: 'ciphertext', summary: [] }, call] } }]
      : [{ type: 'response.output_text.delta', delta: 'Done.' }, { type: 'response.completed', response: { status: 'completed', output: [] } }]);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, uncancelled); assert.equal(models.length, 1);
    const parts: vscode.LanguageModelResponsePart[] = [];
    const requestOptions = { ...options, tools: [{ name: 'edit', description: 'edit a file', inputSchema: { type: 'object' } }] };
    await provider.provideLanguageModelChatResponse(models[0]!, [message('Edit this file')], requestOptions, { report: part => parts.push(part) }, uncancelled);
    assert.equal((parts[0] as vscode.LanguageModelTextPart).value, 'Editing.');
    assert.equal((parts[1] as vscode.LanguageModelToolCallPart).name, 'edit');
    const call = parts[1] as vscode.LanguageModelToolCallPart;
    const history = [message('Edit this file'), { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: [call] },
      { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('File updated')])] }];
    const next: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(models[0]!, history, requestOptions, { report: part => next.push(part) }, uncancelled);
    assert.equal((next[0] as vscode.LanguageModelTextPart).value, 'Done.');
    const input = bodies[1]!.input as Record<string, unknown>[]; assert.ok(input.some(item => item.type === 'function_call_output' && item.output === 'File updated'));
    assert.ok(input.some(item => item.type === 'reasoning' && item.encrypted_content === 'ciphertext'));
    assert.equal(bodies[0]!.store, false); assert.ok(!('previous_response_id' in bodies[1]!));
  } finally { provider.dispose(); accounts.dispose(); }
});
test('Copilot receives no tool call when a streamed turn fails late', async () => {
  const accounts = new AccountManager(new MemoryStore([registration()]), oauth()); const parts: vscode.LanguageModelResponsePart[] = [];
  const http = new HttpClient(fake(url => url === `${API}/models` ? json({ models: [{ slug: 'test', visibility: 'list' }] }) : sse([
    { type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', namespace: 'copilot', call_id: '1', name: wireToolName('edit'), arguments: '{}' } },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }
  ])));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, uncancelled);
    await assert.rejects(provider.provideLanguageModelChatResponse(models[0]!, [message('edit')], { ...options, tools: [{ name: 'edit', description: 'edit', inputSchema: {} }] }, { report: part => parts.push(part) }, uncancelled), { name: 'Blocked' });
    assert.equal(parts.length, 0);
  } finally { provider.dispose(); accounts.dispose(); }
});
test('stale models are rechecked against the new account catalog before sending chat', async () => {
  const store = new MemoryStore([registration(), registration('oaiapp_B')]); const accounts = new AccountManager(store, oauth()); let inference = 0;
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) { const token = (init.headers as Record<string, string>).Authorization ?? ''; return json({ models: [{ slug: token.includes('oaiapp_B') ? 'B-model' : 'A-model', visibility: 'list' }] }); }
    inference++; throw new Error('must not infer');
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const old = (await provider.provideLanguageModelChatInformation({ silent: true }, uncancelled))[0]!;
    await accounts.select('oaiapp_B', signal());
    await assert.rejects(provider.provideLanguageModelChatResponse(old, [message('hello')], options, { report() {} }, uncancelled), /current account/); assert.equal(inference, 0);
  } finally { provider.dispose(); accounts.dispose(); }
});
test('normalization rejects unsupported parts instead of silently losing context', () => {
  assert.throws(() => normalizeMessage({ ...message(''), content: [{ unsupported: 'part' }] }), /unsupported/);
  assert.throws(() => normalizeMessage({ ...message(''), content: [new vscode.LanguageModelDataPart(Uint8Array.of(1), 'audio/wav')] }), /attachment/);
});
