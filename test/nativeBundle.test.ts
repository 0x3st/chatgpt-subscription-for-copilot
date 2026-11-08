import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as vscode from 'vscode';
import type { ChatGPTProvider } from '../src/provider';
import { API } from '../src/core';
import { newVault } from '../src/auth/store';
import { json, registration, sse } from './helpers';
import * as api from './vscode.mock';

test('shipping CJS exposes native submenus, consumes choices and reports actual usage without real credentials or inference', async () => {
  const filename = resolve('.test-build/extension-under-test.cjs');
  const source = await readFile(filename, 'utf8'); const load = createRequire(filename);
  const module = { exports: {} as { activate(context: vscode.ExtensionContext): void } };
  const bodies: Record<string, unknown>[] = [];
  runInNewContext(source, {
    module, exports: module.exports, require: (id: string) => id === 'vscode' ? api : load(id),
    process, global: globalThis, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    setImmediate, clearImmediate, queueMicrotask, AbortController, AbortSignal, URL, URLSearchParams,
    TextDecoder, TextEncoder, crypto: globalThis.crypto,
    fetch: async (url: string, init: RequestInit) => {
      if (url === `${API}/models`) return json({ models: [{ slug: 'test-model', display_name: 'Test', visibility: 'list',
        max_input_tokens: 1000000, max_output_tokens: 64000, supported_reasoning_efforts: ['low', 'high'] }] });
      assert.equal(url, `${API}/responses`);
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sse([{ type: 'response.output_text.delta', delta: 'Synthetic reply' },
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 24000, output_tokens: 300, input_tokens_details: { cached_tokens: 12000 } } } }]);
    }
  }, { filename, timeout: 5000 });
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-native-bundle-'));
  const vault = newVault(); vault.registrations = [registration()]; vault.active = 'oaiapp_A';
  let raw = JSON.stringify(vault);
  const subscriptions: { dispose(): void }[] = [];
  const context = {
    globalStorageUri: { scheme: 'vscode-userdata', authority: '', fsPath: directory }, subscriptions,
    secrets: { get: async () => raw, store: async (_key: string, value: string) => { raw = value; }, onDidChange: () => ({ dispose() {} }) },
    globalState: { get: () => true, update: async () => undefined }
  } as unknown as vscode.ExtensionContext;
  const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  try {
    module.exports.activate(context);
    assert.equal(bodies.length, 0);
    const provider = api.registeredProviders.get('chatgpt-subscription-preview') as ChatGPTProvider; assert.ok(provider);
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.equal(models.length, 1);
    const info = models[0]!; const properties = info.configurationSchema.properties;
    assert.equal(properties.reasoningEffort!.group, 'navigation'); assert.ok(properties.reasoningEffort!.enumItemLabels.includes('High'));
    assert.equal(properties.contextSize!.group, 'tokens'); assert.ok(properties.contextSize!.enumItemLabels.includes('Max 1M'));
    const parts: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(info, [{ role: api.LanguageModelChatMessageRole.User, name: undefined,
      content: [new api.LanguageModelTextPart('Synthetic request')] }], {
      toolMode: api.LanguageModelChatToolMode.Auto, modelConfiguration: { reasoningEffort: 'high', contextSize: 64000 }
    }, { report: part => parts.push(part) }, token);
    assert.equal(parts.length, 2); assert.ok(parts[0] instanceof api.LanguageModelTextPart); assert.equal(parts[0].value, 'Synthetic reply');
    assert.ok(parts[1] instanceof api.LanguageModelDataPart); assert.equal(parts[1].mimeType, 'usage');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(parts[1].data)), {
      prompt_tokens: 24000, completion_tokens: 300, total_tokens: 24300, prompt_tokens_details: { cached_tokens: 12000 }
    });
    assert.equal(bodies.length, 1); assert.deepEqual(bodies[0]!.reasoning, { effort: 'high' });
    assert.ok(!('contextSize' in bodies[0]!)); assert.ok(!('max_output_tokens' in bodies[0]!));
    assert.equal(api.browserOpens, 0);
  } finally {
    for (const sub of subscriptions) sub.dispose();
    await assert.rejects(access(join(directory, 'session.lock')));
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(api.registeredCommands.size, 0); assert.equal(api.registeredProviders.size, 0);
});
