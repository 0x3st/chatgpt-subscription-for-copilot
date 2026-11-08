import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { activate } from '../src/extension';
import { AccountManager } from '../src/auth/accounts';
import { AppError } from '../src/core';
import { registeredCommands, window, browserOpens } from './vscode.mock';

for (const scenario of ['success', 'dismissed', 'existing', 'denied', 'cancelled', 'closed'] as const) {
  test(`plan-use notice after successful enabled sign-in: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatgpt-sub-notice-'));
    const subscriptions: { dispose(): void }[] = [];
    const state = new Map<string, unknown>();
    if (scenario === 'existing') state.set('previewConsent.v1', true);
    let loggedIn = false; let notices = 0; let requests = 0; let attempts = 0;
    const original = { login: AccountManager.prototype.login, snapshot: AccountManager.prototype.snapshot,
      progress: window.withProgress, info: window.showInformationMessage, fetch: globalThis.fetch };
    AccountManager.prototype.login = async () => {
      if (attempts++ === 0) assert.equal(notices, 0, 'The notice must not precede successful authentication');
      if (scenario === 'cancelled') throw new AppError('Synthetic cancellation', 'cancelled');
      loggedIn = true;
    };
    AccountManager.prototype.snapshot = async () => ({ epoch: 'synthetic-epoch', active: 'synthetic-client',
      accounts: loggedIn ? [{ clientId: 'synthetic-client', label: 'Synthetic account', signedIn: true, enabled: scenario !== 'denied' }] : [] });
    window.withProgress = async (_options, task) => task(undefined, {
      isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} })
    });
    window.showInformationMessage = async (...args) => {
      if (args[0] === "You're using your ChatGPT plan") {
        assert.equal(loggedIn, true); assert.notEqual(scenario, 'denied');
        assert.equal(state.get('previewConsent.v1'), undefined, 'Do not mark a notice before showing it');
        assert.equal((args[1] as { modal: boolean }).modal, true);
        assert.match((args[1] as { detail: string }).detail, /shared usage limits/);
        assert.match((args[1] as { detail: string }).detail, /ChatGPT Settings/);
        assert.match((args[1] as { detail: string }).detail, /not automatically switch to API-key billing/);
        notices++;
        if (scenario === 'closed') for (const sub of subscriptions) sub.dispose();
        return scenario === 'dismissed' ? undefined : 'Got it';
      }
      return undefined;
    };
    globalThis.fetch = async () => { requests++; throw new Error('Real network forbidden'); };
    const context = { subscriptions, globalStorageUri: { scheme: 'file', authority: '', fsPath: directory },
      secrets: { get: async () => undefined, store: async () => { throw new Error('No real token storage'); }, onDidChange: () => ({ dispose() {} }) },
      globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } }
    } as unknown as vscode.ExtensionContext;
    try {
      activate(context);
      const signIn = registeredCommands.get('chatgptSub.signIn'); assert.ok(signIn);
      await signIn();
      const eligible = scenario === 'success' || scenario === 'dismissed';
      assert.equal(notices, eligible || scenario === 'closed' ? 1 : 0);
      assert.equal(state.get('previewConsent.v1'), eligible || scenario === 'existing' ? true : undefined);
      if (eligible) {
        loggedIn = false; await signIn(); assert.equal(loggedIn, true);
        assert.equal(notices, 1, 'Do not repeat a dismissed or acknowledged notice');
      }
      assert.equal(requests, 0); assert.equal(browserOpens, 0);
    } finally {
      for (const sub of subscriptions) sub.dispose();
      AccountManager.prototype.login = original.login; AccountManager.prototype.snapshot = original.snapshot;
      window.withProgress = original.progress; window.showInformationMessage = original.info; globalThis.fetch = original.fetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
