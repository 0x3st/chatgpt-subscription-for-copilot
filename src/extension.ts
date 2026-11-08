import * as vscode from 'vscode';
import { AccountManager } from './auth/accounts';
import { OAuthClient } from './auth/oauth';
import { LockedAccountStore, SECRET_KEY } from './auth/store';
import { USAGE, safeError } from './core';
import { HttpClient } from './http';
import { ChatGPTProvider, VENDOR } from './provider';
import { cancellation, localStorageDirectory } from './vscodeAdapter';

export function activate(context: vscode.ExtensionContext): void {
  const storageDirectory = localStorageDirectory(context.globalStorageUri, vscode.env.uiKind);
  const log = vscode.window.createOutputChannel('ChatGPT Subscription', { log: true });
  const lifetime = new AbortController();
  const http = new HttpClient();
  const accounts = new AccountManager(new LockedAccountStore(context.secrets, storageDirectory), new OAuthClient(http));
  context.subscriptions.push(log, accounts, { dispose: () => lifetime.abort() });

  const report = (error: unknown) => {
    const safe = safeError(error);
    if (safe.kind !== 'cancelled') { log.warn(`${safe.kind}: ${safe.message}`); void vscode.window.showErrorMessage(safe.message); }
  };
  const guarded = (action: () => PromiseLike<unknown>) => async () => { try { await action(); } catch (error) { report(error); } };
  let pendingLogin: Promise<boolean> | undefined;
  const signIn = (clientId?: string): Promise<boolean> => {
    if (pendingLogin) return pendingLogin;
    pendingLogin = (async () => {
      try {
        if (!context.globalState.get<boolean>('previewConsent.v1')) {
          const yes = await vscode.window.showWarningMessage(
            'Continue with ChatGPT: this extension uses the official OpenAI Preview subscription-sharing feature. Requests and the code, images, and tool results supplied by Copilot are sent to OpenAI and count toward your shared usage limits. It will not automatically switch to API-key billing.',
            { modal: true }, 'Continue');
          if (yes !== 'Continue') return false;
          await context.globalState.update('previewConsent.v1', true);
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
          title: 'Continue with ChatGPT (Preview)', cancellable: true }, async (_progress, token) => {
          const cancel = cancellation(token);
          const signal = AbortSignal.any([cancel.signal, lifetime.signal]);
          try {
            await accounts.login(async url => {
              if (!await vscode.env.openExternal(vscode.Uri.parse(url))) throw new Error('Browser unavailable');
            }, signal, clientId);
          } finally { cancel.dispose(); }
        });
        const snapshot = await accounts.snapshot(lifetime.signal);
        const active = snapshot.accounts.find(item => item.clientId === snapshot.active);
        if (active?.enabled) void vscode.window.showInformationMessage(`Connected: ${active.label} (Preview). Enable its models in Copilot's Manage Models.`);
        else void vscode.window.showWarningMessage('Signed in, but ChatGPT subscription access was not granted. Reauthorize in Manage Accounts. No inference request was made.');
        return !!active?.enabled;
      } catch (error) { report(error); return false; }
    })().finally(() => { pendingLogin = undefined; });
    return pendingLogin;
  };
  const provider = new ChatGPTProvider(accounts, http, clientId => signIn(clientId), log);
  context.subscriptions.push(provider, accounts.onChange(() => provider.refresh()),
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    context.secrets.onDidChange(event => {
      if (event.key === SECRET_KEY) void accounts.synchronize(lifetime.signal).catch(report);
    }));
  const signOut = async () => {
    const yes = await vscode.window.showWarningMessage('Sign out of the active ChatGPT account and attempt to revoke its renewable session? Other saved accounts are unaffected.', { modal: true }, 'Sign Out');
    if (yes !== 'Sign Out') return;
    const revoked = await accounts.signOut(lifetime.signal);
    if (revoked) void vscode.window.showInformationMessage('Local tokens cleared and the session revoked. Account registration is retained for your next sign-in.');
    else void vscode.window.showWarningMessage('Local tokens cleared, but remote revocation was not confirmed. Disconnect this app in ChatGPT Settings.');
  };
  const manage = async () => {
    const snapshot = await accounts.snapshot(lifetime.signal);
    type Item = vscode.QuickPickItem & { run(): PromiseLike<unknown> };
    const choices: Item[] = snapshot.accounts.map(account => ({
      label: `${account.clientId === snapshot.active ? '$(check) ' : ''}${account.label}`,
      description: !account.signedIn ? 'Signed out' : account.enabled ? 'Subscription authorized' : 'Subscription authorization required',
      run: async () => {
        if (!account.signedIn) return signIn(account.clientId);
        const action = await vscode.window.showQuickPick(['Switch to this account', 'Sign in again / authorize subscription'], { title: account.label });
        if (action === 'Switch to this account') await accounts.select(account.clientId, lifetime.signal);
        if (action === 'Sign in again / authorize subscription') await signIn(account.clientId);
      }
    }));
    choices.push({ label: '$(add) Continue with ChatGPT — Add an account or workspace', run: () => signIn() },
      { label: '$(refresh) Refresh Models', run: async () => provider.refresh() },
      { label: '$(link-external) ChatGPT Usage', run: () => vscode.env.openExternal(vscode.Uri.parse(USAGE)) });
    if (snapshot.active) choices.push({ label: '$(sign-out) Sign Out of Active Account', run: signOut });
    const selected = await vscode.window.showQuickPick(choices, { title: 'ChatGPT Subscription (Preview)', placeHolder: 'Account and workspace registrations are stored separately. Subscription usage may be shared with other apps.' });
    await selected?.run();
  };
  for (const [command, action] of [
    ['chatgptSub.manage', manage], ['chatgptSub.signIn', () => signIn()], ['chatgptSub.signOut', signOut],
    ['chatgptSub.refreshModels', async () => { provider.refresh(); void vscode.window.showInformationMessage('Model cache cleared. Copilot will query the catalog again.'); }],
    ['chatgptSub.usage', () => vscode.env.openExternal(vscode.Uri.parse(USAGE))], ['chatgptSub.logs', async () => log.show(true)]
  ] as const) context.subscriptions.push(vscode.commands.registerCommand(command, guarded(action)));
  void accounts.synchronize(lifetime.signal).catch(report);
}
export function deactivate(): void { /* context.subscriptions owns all resources. */ }
