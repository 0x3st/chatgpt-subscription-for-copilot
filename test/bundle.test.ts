import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as vscode from 'vscode';
import type { ChatGPTProvider } from '../src/provider';
import * as api from './vscode.mock';

test('shipping CJS bundle activates with desktop vscode-userdata storage and registers callable sign-in', async () => {
  const filename = resolve('.test-build/extension-under-test.cjs');
  const source = await readFile(filename, 'utf8');
  const load = createRequire(filename);
  const module = { exports: {} as { activate(context: vscode.ExtensionContext): void } };
  let requests = 0;
  runInNewContext(source, {
    module, exports: module.exports,
    require: (id: string) => id === 'vscode' ? api : load(id),
    process, global: globalThis, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    setImmediate, clearImmediate, queueMicrotask, AbortController, AbortSignal, URL, URLSearchParams,
    TextDecoder, TextEncoder, crypto: globalThis.crypto,
    fetch: async () => { requests++; throw new Error('No real network in bundle regression test'); }
  }, { filename, timeout: 5000 });
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-sub-bundle-'));
  let raw: string | undefined;
  const subscriptions: { dispose(): void }[] = [];
  const context = {
    globalStorageUri: { scheme: 'vscode-userdata', authority: '', fsPath: directory }, subscriptions,
    secrets: { get: async () => raw, store: async (_key: string, value: string) => { raw = value; }, onDidChange: () => ({ dispose() {} }) },
    globalState: { get: () => undefined, update: async () => undefined }
  } as unknown as vscode.ExtensionContext;
  try {
    module.exports.activate(context);
    const signIn = api.registeredCommands.get('chatgptSub.signIn'); assert.ok(signIn); await signIn();
    const provider = api.registeredProviders.get('chatgpt-subscription-preview') as ChatGPTProvider;
    assert.ok(provider);
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, {
      isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} })
    });
    assert.equal(models.length, 0); assert.equal(requests, 0); assert.equal(api.browserOpens, 0);
  } finally {
    for (const sub of subscriptions) sub.dispose();
    await assert.rejects(access(join(directory, 'session.lock')));
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(api.registeredCommands.size, 0); assert.equal(api.registeredProviders.size, 0);
});
