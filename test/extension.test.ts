import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { activate } from '../src/extension';
import { localStorageDirectory } from '../src/vscodeAdapter';
import { parseVault } from '../src/auth/store';
import type { ChatGPTProvider } from '../src/provider';
import { registeredCommands, registeredProviders, registeredTools, notebookStatusProviders, browserOpens, configuration } from './vscode.mock';

for (const scheme of ['file', 'vscode-userdata']) test(`desktop activation with ${scheme}: registers callable sign-in command without login or network`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-sub-activation-'));
  let raw: string | undefined; let requests = 0;
  const subscriptions: { dispose(): void }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('Network forbidden in activation test'); };
  const context = {
    globalStorageUri: { scheme, authority: '', fsPath: directory }, subscriptions,
    secrets: { get: async () => raw, store: async (_key: string, value: string) => { raw = value; }, onDidChange: () => ({ dispose() {} }) },
    globalState: { get: () => undefined, update: async () => undefined }
  } as unknown as vscode.ExtensionContext;
  try {
    activate(context);
    const provider = registeredProviders.get('chatgpt-subscription-preview') as ChatGPTProvider;
    assert.ok(provider); assert.equal(registeredCommands.size, 7);
    assert.equal(registeredTools.size, 0); assert.equal(notebookStatusProviders.size, 0);
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      publisher: string; name: string; contributes: { commands: { command: string }[]; languageModelChatProviders: { managementCommand: string }[] };
    };
    assert.equal(`${manifest.publisher}.${manifest.name}`, 'lab530.chatgpt-subscription-for-copilot');
    assert.deepEqual([...registeredCommands.keys()].sort(), manifest.contributes.commands.map(item => item.command).sort());
    for (const contribution of manifest.contributes.languageModelChatProviders) assert.ok(registeredCommands.has(contribution.managementCommand));
    let refreshes = 0; const refresh = provider.refresh.bind(provider);
    provider.refresh = () => { refreshes++; refresh(); };
    await vscode.workspace.getConfiguration('chatgptSub').update('modelOverrides', {}, vscode.ConfigurationTarget.Global);
    assert.ok(refreshes > 0, 'User configuration changes must refresh the model information');
    const signIn = registeredCommands.get('chatgptSub.signIn'); assert.ok(signIn);
    await signIn(); // The progress mock cancels before authentication; no real browser or network.
    const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }, token), []);
    assert.equal(parseVault(raw).registrations.length, 0); assert.equal(requests, 0); assert.equal(browserOpens, 0);
  } finally {
    for (const sub of subscriptions) sub.dispose(); globalThis.fetch = originalFetch;
    delete configuration.modelOverrides;
    await assert.rejects(access(join(directory, 'session.lock')));
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(registeredProviders.size, 0); assert.equal(registeredCommands.size, 0);
  assert.equal(registeredTools.size, 0); assert.equal(notebookStatusProviders.size, 0);
});

test('storage guard still rejects web, remote and relative storage paths', () => {
  const uri = (scheme: string, fsPath: string, authority = '') => ({ scheme, fsPath, authority }) as vscode.Uri;
  const path = join(tmpdir(), 'test-storage');
  assert.equal(localStorageDirectory(uri('vscode-userdata', path), vscode.UIKind.Desktop), path);
  assert.throws(() => localStorageDirectory(uri('file', path), vscode.UIKind.Web), /desktop extension host/);
  assert.throws(() => localStorageDirectory(uri('vscode-remote', path, 'ssh-remote+host'), vscode.UIKind.Desktop));
  assert.throws(() => localStorageDirectory(uri('vscode-userdata', 'relative/path'), vscode.UIKind.Desktop));
  assert.throws(() => localStorageDirectory(uri('file', path, 'remote-host'), vscode.UIKind.Desktop));
});
