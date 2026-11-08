import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { activate } from '../src/extension';
import { AccountManager, type AccountSummary, type Snapshot } from '../src/auth/accounts';
import { registeredCommands, window, browserOpens } from './vscode.mock';

const account = (clientId: string, signedIn = false): AccountSummary => ({ clientId, label: `Saved ${clientId}`, signedIn, enabled: signedIn });

for (const scenario of ['active', 'only retained', 'multiple retained', 'cancel selection', 'first login', 'explicit add', 'explicit reconnect'] as const) {
  test(`sign-in registration selection: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatgpt-reconnect-test-'));
    const subscriptions: { dispose(): void }[] = [];
    const initial: Snapshot = scenario === 'first login' ? { epoch: 'before', accounts: [] }
      : scenario === 'only retained' ? { epoch: 'before', accounts: [account('oaiapp_A')] }
      : scenario === 'multiple retained' || scenario === 'cancel selection' ? { epoch: 'before', accounts: [account('oaiapp_A'), account('oaiapp_B')] }
      : { epoch: 'before', active: 'oaiapp_A', accounts: [account('oaiapp_A', true), account('oaiapp_B')] };
    let current = initial; let requests = 0; let picks = 0; const targets: (string | undefined)[] = [];
    const original = { login: AccountManager.prototype.login, snapshot: AccountManager.prototype.snapshot,
      progress: window.withProgress, pick: window.showQuickPick, fetch: globalThis.fetch };
    AccountManager.prototype.snapshot = async () => structuredClone(current);
    AccountManager.prototype.login = async (_openUrl, _signal, clientId) => {
      targets.push(clientId);
      const selected = clientId ?? 'oaiapp_new';
      current = { epoch: 'after', active: selected, accounts: [account(selected, true)] };
    };
    window.withProgress = async (_options, task) => task(undefined, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    window.showQuickPick = async (items, pickOptions) => {
      picks++;
      const values = items as { label: string; clientId?: string }[];
      const title = (pickOptions as { title?: string } | undefined)?.title;
      if (scenario === 'explicit add') return values.find(item => item.label.includes('Add an account or workspace'));
      if (scenario === 'explicit reconnect') return values.find(item => item.label.includes('oaiapp_B'));
      assert.equal(title, 'Reconnect ChatGPT');
      if (scenario === 'cancel selection') return undefined;
      return values.find(item => item.clientId === 'oaiapp_B');
    };
    globalThis.fetch = async () => { requests++; throw new Error('Real network forbidden'); };
    const context = { subscriptions, globalStorageUri: { scheme: 'file', authority: '', fsPath: directory },
      secrets: { get: async () => undefined, store: async () => undefined, onDidChange: () => ({ dispose() {} }) },
      globalState: { get: () => true, update: async () => undefined }
    } as unknown as vscode.ExtensionContext;
    try {
      activate(context);
      const command = registeredCommands.get(scenario.startsWith('explicit') ? 'chatgptSub.manage' : 'chatgptSub.signIn'); assert.ok(command);
      await command();
      if (scenario === 'cancel selection') assert.deepEqual(targets, []);
      else assert.deepEqual(targets, [scenario === 'first login' || scenario === 'explicit add' ? undefined
        : scenario === 'multiple retained' || scenario === 'explicit reconnect' ? 'oaiapp_B' : 'oaiapp_A']);
      if (scenario === 'active' || scenario === 'only retained' || scenario === 'first login') assert.equal(picks, 0);
      else assert.equal(picks, 1);
      assert.equal(requests, 0); assert.equal(browserOpens, 0);
    } finally {
      for (const sub of subscriptions) sub.dispose();
      AccountManager.prototype.login = original.login; AccountManager.prototype.snapshot = original.snapshot;
      window.withProgress = original.progress; window.showQuickPick = original.pick; globalThis.fetch = original.fetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
