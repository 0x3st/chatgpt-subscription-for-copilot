import * as vscode from 'vscode';
import { AccountManager } from './auth/accounts';
import { OAuthClient } from './auth/oauth';
import { LockedAccountStore, SECRET_KEY } from './auth/store';
import { USAGE, safeError } from './core';
import { HttpClient } from './http';
import { ChatGPTProvider, VENDOR } from './provider';
import { refreshNativePicker } from './modelPicker';
import { cancellation, localStorageDirectory } from './vscodeAdapter';
import { registerNotebookTools } from './notebookTools';

export function activate(context: vscode.ExtensionContext): void {
  const storageDirectory = localStorageDirectory(context.globalStorageUri, vscode.env.uiKind);
  const log = vscode.window.createOutputChannel('ChatGPT Subscription', { log: true });
  const lifetime = new AbortController();
  const http = new HttpClient();
  const accounts = new AccountManager(new LockedAccountStore(context.secrets, storageDirectory), new OAuthClient(http));
  context.subscriptions.push(log, accounts, { dispose: () => lifetime.abort() });
  registerNotebookTools(context);

  const report = (error: unknown) => {
    const safe = safeError(error);
    if (safe.kind !== 'cancelled') { log.warn(`${safe.kind}: ${safe.message}`); void vscode.window.showErrorMessage(safe.message); }
  };
  const guarded = (action: () => PromiseLike<unknown>) => async () => { try { await action(); } catch (error) { report(error); } };
  let pendingLogin: Promise<boolean> | undefined;
  const signIn = (clientId?: string, intent: 'reconnect' | 'add' = 'reconnect'): Promise<boolean> => {
    if (pendingLogin) return pendingLogin;
    pendingLogin = (async () => {
      try {
        let target = clientId;
        if (!target && intent === 'reconnect') {
          const saved = await accounts.snapshot(lifetime.signal);
          const active = saved.accounts.find(account => account.clientId === saved.active);
          if (active) target = active.clientId;
          else if (saved.accounts.length === 1) target = saved.accounts[0]!.clientId;
          else if (saved.accounts.length > 1) {
            const selected = await vscode.window.showQuickPick(saved.accounts.map(account => ({
              label: account.label, description: account.signedIn ? 'Reconnect saved registration' : 'Signed out', clientId: account.clientId
            })), { title: 'Reconnect ChatGPT', placeHolder: 'Choose a saved registration. To add an account or workspace, use Manage Accounts.' });
            if (!selected || lifetime.signal.aborted) return false;
            target = selected.clientId;
          }
        }
        if (lifetime.signal.aborted) return false;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
          title: 'Continue with ChatGPT (Preview)', cancellable: true }, async (_progress, token) => {
          const cancel = cancellation(token);
          const signal = AbortSignal.any([cancel.signal, lifetime.signal]);
          try {
            await accounts.login(async url => {
              if (!await vscode.env.openExternal(vscode.Uri.parse(url))) throw new Error('Browser unavailable');
            }, signal, target);
          } finally { cancel.dispose(); }
        });
        const snapshot = await accounts.snapshot(lifetime.signal);
        const active = snapshot.accounts.find(item => item.clientId === snapshot.active);
        if (active?.enabled) {
          // Honor earlier acknowledgments: move the existing notice, do not add a second one.
          if (context.globalState.get<boolean>('previewConsent.v1') !== true) {
            await vscode.window.showInformationMessage("You're using your ChatGPT plan", {
              modal: true,
              detail: 'Eligible AI requests in this extension use your ChatGPT plan and count toward its shared usage limits. Code, images, and tool results supplied by Copilot are sent to OpenAI through its official Preview subscription-sharing feature. Manage usage and limits in ChatGPT Settings. The extension will not automatically switch to API-key billing.'
            }, 'Got it');
            if (lifetime.signal.aborted) return false;
            await context.globalState.update('previewConsent.v1', true);
          }
          void vscode.window.showInformationMessage(`Connected: ${active.label} (Preview). Enable its models in Copilot's Manage Models.`);
        } else void vscode.window.showWarningMessage('Signed in, but ChatGPT subscription access was not granted. Reauthorize in Manage Accounts. No inference request was made.');
        return !!active?.enabled;
      } catch (error) { report(error); return false; }
    })().finally(() => { pendingLogin = undefined; });
    return pendingLogin;
  };
  const provider = new ChatGPTProvider(accounts, http, clientId => signIn(clientId), log);
  context.subscriptions.push(provider, accounts.onChange(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('chatgptSub')) provider.refresh(); }),
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    context.secrets.onDidChange(event => {
      if (event.key === SECRET_KEY) void accounts.synchronize(lifetime.signal).catch(report);
    }));
  context.subscriptions.push(refreshNativePicker(() => provider.refresh(), lifetime.signal));
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
    choices.push({ label: '$(add) Continue with ChatGPT — Add an account or workspace', run: () => signIn(undefined, 'add') },
      { label: '$(settings-gear) Advanced Model Defaults', run: () => provider.configureModel(lifetime.signal) },
      { label: '$(refresh) Refresh Models', run: async () => provider.refresh(true) },
      { label: '$(link-external) ChatGPT Usage', run: () => vscode.env.openExternal(vscode.Uri.parse(USAGE)) });
    if (snapshot.active) choices.push({ label: '$(sign-out) Sign Out of Active Account', run: signOut });
    const selected = await vscode.window.showQuickPick(choices, { title: 'ChatGPT Subscription (Preview)', placeHolder: 'Account and workspace registrations are stored separately. Subscription usage may be shared with other apps.' });
    await selected?.run();
  };
  for (const [command, action] of [
    ['chatgptSub.manage', manage], ['chatgptSub.signIn', () => signIn()], ['chatgptSub.signOut', signOut],
    ['chatgptSub.configureModel', () => provider.configureModel(lifetime.signal)],
    ['chatgptSub.refreshModels', async () => { provider.refresh(true); void vscode.window.showInformationMessage('Model cache and local retry pause cleared. Copilot will query the catalog again. This does not reset upstream usage limits.'); }],
    ['chatgptSub.usage', () => vscode.env.openExternal(vscode.Uri.parse(USAGE))], ['chatgptSub.logs', async () => log.show(true)]
  ] as const) context.subscriptions.push(vscode.commands.registerCommand(command, guarded(action)));
  void accounts.synchronize(lifetime.signal).catch(report);
}
export function deactivate(): void { /* context.subscriptions owns all resources. */ }
