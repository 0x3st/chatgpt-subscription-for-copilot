import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { AccountManager } from '../src/auth/accounts';
import { API, apiError } from '../src/core';
import { HttpClient } from '../src/http';
import { ChatGPTProvider } from '../src/provider';
import { MemoryStore, fake, json, oauth, registration, signal, sse } from './helpers';

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
const options = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const message: vscode.LanguageModelChatRequestMessage = { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelTextPart('Hi')] };

test('known SSE error codes override successful transport status without exposing raw server messages', () => {
  for (const [code, kind] of [['rate_limit_exceeded', 'quota'], ['insufficient_quota', 'quota'], ['context_length_exceeded', 'protocol'],
    ['invalid_prompt', 'protocol'], ['subscription_sharing_usage_limit_exceeded', 'quota'], ['subscription_sharing_route_not_supported', 'permission'],
    ['subscription_sharing_invalid_user', 'auth'], ['subscription_sharing_usage_unavailable', 'network']]) {
    for (const status of [200, 400, 429, 503]) {
      const error = apiError(status, { error: { code, message: 'PRIVATE token and chat body' } }, 'req_test');
      assert.equal(error.kind, kind); assert.equal(error.status, status); assert.equal(error.code, code); assert.equal(error.requestId, 'req_test');
      assert.doesNotMatch(error.message, /PRIVATE/);
    }
  }
  for (const code of ['unknown_future_code', '__proto__', 'constructor', 'toString']) {
    const error = apiError(200, { error: { code } }); assert.equal(error.kind, 'network'); assert.match(error.message, /HTTP 200/);
  }
});

test('subscription-sharing limits do not claim the whole plan is exhausted or invent a reset time', () => {
  const error = apiError(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', reset_at: 'PRIVATE guess' } });
  assert.match(error.message, /app-specific/); assert.match(error.message, /does not establish.*entire ChatGPT plan/);
  assert.doesNotMatch(error.message, /PRIVATE|reset_at/);
  assert.match(apiError(200, { error: { code: 'subscription_sharing_usage_unavailable' } }).message, /not confirmation/);
});

test('both HTTP and SSE quota failures block repeated upstream requests, without sliding the local deadline', async () => {
  for (const transport of ['http', 'sse']) {
    const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
    const accounts = new AccountManager(new MemoryStore([registration()]), oauth()); let sent = 0;
    const http = new HttpClient(fake(url => {
      if (url === `${API}/models`) return json({ models: [{ slug: 'test', visibility: 'list' }] });
      sent++;
      return transport === 'http' ? json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429)
        : sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]);
    }));
    const provider = new ChatGPTProvider(accounts, http, async () => false, log);
    try {
      const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
      for (let i = 0; i < 6; i++) {
        await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report() {} }, token),
          error => error instanceof Error && error.name === 'Blocked' && /paused locally/.test(error.message) && /not a quota reset estimate/.test(error.message));
        now += 5000;
      }
      assert.equal(sent, 1, 'Six caller attempts must cause only one upstream inference request');
      provider.refresh();
      await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report() {} }, token)); assert.equal(sent, 1, 'Passive refresh must not clear the pause');
      now += 31000;
      await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report() {} }, token)); assert.equal(sent, 2, 'The original deadline expires without being extended by cached errors');
      provider.refresh(true);
      await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report() {} }, token)); assert.equal(sent, 3, 'Explicit user refresh can clear the local pause');
    } finally { provider.dispose(); accounts.dispose(); Date.now = originalNow; }
  }
});

test('local quota pauses cover the active registration, never an unrelated account', async () => {
  const accounts = new AccountManager(new MemoryStore([registration(), registration('oaiapp_B')]), oauth()); let sent = 0;
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) return json({ models: [{ slug: 'one', visibility: 'list' }, { slug: 'two', visibility: 'list' }] });
    sent++;
    return new Headers(init.headers).get('Authorization')?.includes('oaiapp_B')
      ? sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }])
      : sse([{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }]);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const info = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.equal(info.length, 2);
    await assert.rejects(provider.provideLanguageModelChatResponse(info[0]!, [message], options, { report() {} }, token), { name: 'Blocked' });
    await assert.rejects(provider.provideLanguageModelChatResponse(info[1]!, [message], options, { report() {} }, token), { name: 'Blocked' }); assert.equal(sent, 1);
    await accounts.select('oaiapp_B', signal());
    await provider.provideLanguageModelChatResponse(info[0]!, [message], options, { report() {} }, token); assert.equal(sent, 2);
  } finally { provider.dispose(); accounts.dispose(); }
});

test('usage-unavailable and ordinary network failures preserve credentials and are not falsely quota-paused', async () => {
  const store = new MemoryStore([registration()]); const accounts = new AccountManager(store, oauth()); let sent = 0;
  const http = new HttpClient(fake(url => {
    if (url === `${API}/models`) return json({ models: [{ slug: 'test', visibility: 'list' }] });
    sent++; return sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable' } } }]);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    assert.equal(sent, 0, 'Discovery does not infer');
    await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report() {} }, token), error => error instanceof Error && error.name !== 'Blocked'); assert.equal(sent, 1, 'The extension itself never retries');
    await assert.rejects(provider.provideLanguageModelChatResponse(info, [message], options, { report() {} }, token)); assert.equal(sent, 2);
    assert.ok(store.state.registrations[0]!.tokens);
  } finally { provider.dispose(); accounts.dispose(); }
});
