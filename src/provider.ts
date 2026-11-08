import { randomUUID, createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { AccountManager } from './auth/accounts';
import { complete } from './chat/client';
import { EFFORTS, editorId, fetchModels, type ChatModel, type Effort } from './chat/models';
import { estimateTokens, prepareRequest } from './chat/request';
import { ReplayCache } from './chat/replay';
import { AppError, checkAbort, deadline, safeError } from './core';
import type { HttpClient } from './http';
import { cancellation, normalizeMessage } from './vscodeAdapter';

export const VENDOR = 'chatgpt-subscription-preview';
export function settings(): { effort: Effort | undefined; summary: boolean; timeoutMs: number } {
  const config = vscode.workspace.getConfiguration('chatgptSub');
  // Explicitly read user/default values as defense in depth, even though all settings are machine-scoped.
  const get = (key: string) => { const value = config.inspect<unknown>(key); return value?.globalValue ?? value?.defaultValue; };
  const effort = get('reasoningEffort'); const timeout = get('requestTimeoutSeconds');
  return { effort: EFFORTS.includes(effort as Effort) ? effort as Effort : undefined,
    summary: get('showReasoningSummary') === true,
    timeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) ? Math.min(1800, Math.max(10, timeout)) * 1000 : 600000 };
}
export class ChatGPTProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changes.event;
  private catalog: { epoch: string; clientId: string; at: number; models: ChatModel[] } | undefined;
  private readonly session = randomUUID();
  private readonly replay = new ReplayCache();
  constructor(private readonly accounts: AccountManager, private readonly http: HttpClient,
    private readonly signIn: (clientId?: string) => Promise<boolean>, private readonly log: vscode.LogOutputChannel) {}
  refresh(): void { this.catalog = undefined; this.changes.fire(); }
  private async models(credentials: { epoch: string; clientId: string; access: string }, signal: AbortSignal): Promise<ChatModel[]> {
    const cache = this.catalog;
    if (cache?.epoch === credentials.epoch && cache.clientId === credentials.clientId && Date.now() - cache.at < 300000) return cache.models;
    const models = await fetchModels(this.http, credentials.access, signal); checkAbort(signal);
    this.catalog = { epoch: credentials.epoch, clientId: credentials.clientId, models, at: Date.now() }; return models;
  }
  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    const cancel = cancellation(token);
    try {
      const snapshot = await this.accounts.snapshot(cancel.signal);
      if (!snapshot.active || !snapshot.accounts.some(account => account.clientId === snapshot.active && account.signedIn)) {
        if (options.silent || !await this.signIn(snapshot.active)) return [];
      }
      const operation = deadline(60000, [cancel.signal, this.accounts.signal]);
      try {
        const credentials = await this.accounts.credentials(operation.signal);
        const models = await this.models(credentials, operation.signal);
        const info = await this.accounts.snapshot(operation.signal); checkAbort(operation.signal);
        if (info.epoch !== credentials.epoch) throw new AppError('The account has changed. Select a model again.', 'cancelled');
        const label = info.accounts.find(account => account.clientId === credentials.clientId)?.label ?? 'ChatGPT';
        return models.map(model => ({ id: editorId(model.id), name: model.name, family: 'chatgpt-subscription', version: model.id,
          maxInputTokens: model.inputTokens, maxOutputTokens: model.outputTokens, detail: `${label} · Preview`,
          tooltip: `${model.name} · ChatGPT subscription (Preview)${model.estimatedLimits ? ' · token limits are conservative estimates' : ''}`,
          capabilities: { imageInput: model.images, toolCalling: model.tools } }));
      } finally { operation.dispose(); }
    } catch (error) { throw this.translate(error); }
    finally { cancel.dispose(); }
  }
  async provideLanguageModelChatResponse(modelInfo: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
    const config = settings(); const cancel = cancellation(token);
    const operation = deadline(config.timeoutMs, [cancel.signal, this.accounts.signal]);
    try {
      const credentials = await this.accounts.credentials(operation.signal);
      const models = await this.models(credentials, operation.signal);
      const model = models.find(item => editorId(item.id) === modelInfo.id);
      if (!model) throw new AppError('The selected model is not available for the current account. Refresh the model list.', 'permission');
      const option = options.modelOptions?.reasoningEffort;
      if (option !== undefined && option !== 'default' && !EFFORTS.includes(option as Effort)) throw new AppError('Invalid reasoning effort.');
      const effort = option === 'default' ? undefined : option as Effort | undefined ?? config.effort;
      const replayScope = JSON.stringify([credentials.clientId, credentials.epoch, model.id]);
      const prepared = this.replay.apply(replayScope, prepareRequest(model, messages.map(normalizeMessage), (options.tools ?? []).map(tool => ({
        name: tool.name, description: tool.description, schema: tool.inputSchema ?? { type: 'object', properties: {} }
      })), options.toolMode === vscode.LanguageModelChatToolMode.Required, effort, config.summary,
      `${this.session}-${createHash('sha256').update(credentials.clientId + credentials.epoch).digest('hex').slice(0, 16)}`));
      let summary = false; let answer = false;
      const result = await complete(this.http, credentials.access, prepared, operation.signal, (type, value) => {
        checkAbort(operation.signal);
        if (type === 'summary') {
          if (!config.summary) return;
          if (!summary) progress.report(new vscode.LanguageModelTextPart('\n\n**Reasoning summary**\n\n'));
          summary = true;
        } else if (!answer) {
          if (summary) progress.report(new vscode.LanguageModelTextPart('\n\n---\n\n'));
          answer = true;
        }
        progress.report(new vscode.LanguageModelTextPart(value));
      }, config.timeoutMs, info => {
        this.log.info(`Responses transport: HTTP ${info.status}; Content-Type: ${info.contentType}; request ID: ${info.requestId ?? 'unavailable'}.`);
      });
      checkAbort(operation.signal);
      this.replay.remember(replayScope, result.replay);
      for (const call of result.tools) {
        checkAbort(operation.signal); progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, call.input));
      }
      this.log.info(`Request completed; input tokens: ${result.inputTokens ?? 'unknown'}; output tokens: ${result.outputTokens ?? 'unknown'}; tool calls: ${result.tools.length}.`);
    } catch (error) { throw this.translate(error); }
    finally { operation.dispose(); cancel.dispose(); }
  }
  async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return estimateTokens(typeof value === 'string' ? value : [normalizeMessage(value)]);
  }
  private translate(error: unknown): Error {
    const safe = safeError(error); this.log.warn(`${safe.kind}: ${safe.message}`);
    if (safe.kind === 'cancelled') return new vscode.CancellationError();
    if (safe.kind === 'auth' || safe.kind === 'permission') return vscode.LanguageModelError.NoPermissions(safe.message);
    if (safe.kind === 'quota') return vscode.LanguageModelError.Blocked(safe.message);
    return safe;
  }
  dispose(): void { this.replay.clear(); this.changes.dispose(); }
}
