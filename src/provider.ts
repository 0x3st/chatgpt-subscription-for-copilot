import { randomUUID, createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { AccountManager } from './auth/accounts';
import { complete } from './chat/client';
import { MathMarkdownStream } from './chat/markdown';
import { EFFORTS, editorId, fetchModels, type ChatModel, type Effort } from './chat/models';
import { estimateTokens, prepareRequest } from './chat/request';
import { ReplayCache } from './chat/replay';
import { AppError, checkAbort, deadline, safeError } from './core';
import type { HttpClient } from './http';
import { cancellation, copilotUsagePart, normalizeMessage } from './vscodeAdapter';
import { contextWindowError, inputBudget, modelOverride, reasoningEffort, saveModelOverride, userSetting } from './modelSettings';
import { pickerEffort, pickerInputBudget, pickerSchema, type NativeModelInformation, type NativeResponseOptions } from './modelPicker';

export const VENDOR = 'chatgpt-subscription-preview';
export function settings(): { effort: Effort | undefined; summary: boolean; timeoutMs: number } {
  // Explicitly read user/default values; workspace overrides cannot affect requests.
  const get = userSetting;
  const effort = get('reasoningEffort'); const timeout = get('requestTimeoutSeconds');
  if (effort !== undefined && effort !== 'default' && !EFFORTS.includes(effort as Effort)) throw new AppError('Invalid reasoningEffort setting. Choose default or a supported effort.');
  return { effort: EFFORTS.includes(effort as Effort) ? effort as Effort : undefined,
    summary: get('showReasoningSummary') === true,
    timeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) ? Math.min(1800, Math.max(10, timeout)) * 1000 : 600000 };
}
export class ChatGPTProvider implements vscode.LanguageModelChatProvider<NativeModelInformation>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changes.event;
  private catalog: { epoch: string; clientId: string; at: number; models: ChatModel[] } | undefined;
  private readonly session = randomUUID();
  private readonly replay = new ReplayCache();
  private readonly quotaPauses = new Map<string, { until: number; error: AppError }>();
  constructor(private readonly accounts: AccountManager, private readonly http: HttpClient,
    private readonly signIn: (clientId?: string) => Promise<boolean>, private readonly log: vscode.LogOutputChannel) {}
  refresh(resumeRequests = false): void {
    this.catalog = undefined;
    if (resumeRequests) this.quotaPauses.clear();
    this.changes.fire();
  }
  private checkQuotaPause(scope: string): void {
    const now = Date.now();
    for (const [key, value] of this.quotaPauses) if (value.until <= now) this.quotaPauses.delete(key);
    const pause = this.quotaPauses.get(scope); if (pause) throw pause.error;
  }
  private pauseQuota(scope: string | undefined, error: unknown): unknown {
    if (!scope || !(error instanceof AppError) || error.kind !== 'quota') return error;
    // Re-throwing the cached error must not extend the fixed local pause.
    if (this.quotaPauses.get(scope)?.error === error) return error;
    const paused = new AppError(`${error.message} Further requests for this account are paused locally for up to 60 seconds to avoid repeated upstream retries. This is not a quota reset estimate. Use ChatGPT Subscription: Refresh Models to clear the local pause after checking access.`,
      error.kind, error.status, error.code, error.requestId, error.bodyShape);
    this.quotaPauses.set(scope, { until: Date.now() + 60000, error: paused });
    while (this.quotaPauses.size > 100) this.quotaPauses.delete(this.quotaPauses.keys().next().value!);
    return paused;
  }
  private async models(credentials: { epoch: string; clientId: string; access: string }, signal: AbortSignal): Promise<ChatModel[]> {
    const cache = this.catalog;
    if (cache?.epoch === credentials.epoch && cache.clientId === credentials.clientId && Date.now() - cache.at < 300000) return cache.models;
    const models = await fetchModels(this.http, credentials.access, signal); checkAbort(signal);
    this.catalog = { epoch: credentials.epoch, clientId: credentials.clientId, models, at: Date.now() }; return models;
  }
  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<NativeModelInformation[]> {
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
        return models.map(model => {
          const override = modelOverride(model.id); const budget = inputBudget(model, override);
          return { id: editorId(model.id), name: model.name, family: 'chatgpt-subscription', version: model.id,
            maxInputTokens: budget, maxOutputTokens: model.outputTokens,
            configurationSchema: pickerSchema(model, settings().effort),
            detail: `${label} · Preview`,
            tooltip: `${model.name} · ChatGPT subscription (Preview)${model.estimatedLimits ? ' · catalog token limits are partly estimated' : ''}${override.contextWindow !== undefined ? ' · user input budget; server capacity is unchanged' : ''}`,
            capabilities: { imageInput: model.images, toolCalling: model.tools } };
        });
      } finally { operation.dispose(); }
    } catch (error) { throw this.translate(error); }
    finally { cancel.dispose(); }
  }
  async configureModel(signal: AbortSignal): Promise<void> {
    const accountSignal = this.accounts.signal;
    const active = AbortSignal.any([signal, accountSignal]);
    const operation = deadline(60000, [active]);
    let models: ChatModel[];
    try {
      const credentials = await this.accounts.credentials(operation.signal);
      models = await this.models(credentials, operation.signal);
      checkAbort(operation.signal);
    } finally { operation.dispose(); }
    const selected = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: model.id, model })), {
      title: 'Advanced ChatGPT Model Defaults', placeHolder: 'Set saved defaults or override missing catalog metadata; chat controls are in the Copilot model menu'
    });
    checkAbort(active); if (!selected) return;
    const model = selected.model;
    const action = await vscode.window.showQuickPick(['Thinking effort', 'Context window', 'Reset model settings'], { title: model.name });
    checkAbort(active); if (!action) return;
    const previous = modelOverride(model.id);
    if (action === 'Thinking effort') {
      const choices: (vscode.QuickPickItem & { value: Effort | 'default' | undefined })[] = [
        { label: 'Use global setting', value: undefined }, { label: 'Model default', description: 'Let the server choose', value: 'default' },
        ...(model.efforts.length ? model.efforts : EFFORTS).map(value => ({ label: value === 'none' ? 'Off (none)' : value, value }))
      ];
      const effort = await vscode.window.showQuickPick(choices, { title: `${model.name}: Thinking effort`,
        placeHolder: model.efforts.length ? 'Only catalog-supported efforts are shown' : 'Capabilities were not reported; the service may reject an explicit effort' });
      checkAbort(active); if (!effort) return;
      const { reasoningEffort: _old, ...rest } = previous;
      await saveModelOverride(model.id, { ...rest, ...(effort.value !== undefined ? { reasoningEffort: effort.value } : {}) });
    } else if (action === 'Context window') {
      const value = await vscode.window.showInputBox({ title: `${model.name}: Input context window`, value: String(inputBudget(model, previous)),
        prompt: model.estimatedInputLimit === true
          ? 'Override missing catalog metadata for Copilot; this does not increase server capacity. Leave blank for the conservative default.'
          : `Input token budget for Copilot, at most the catalog limit of ${model.inputTokens} tokens. Leave blank for the model default.`,
        validateInput: value => contextWindowError(model, value) });
      checkAbort(active); if (value === undefined) return;
      const invalid = contextWindowError(model, value); if (invalid) throw new AppError(invalid);
      const { contextWindow: _old, ...rest } = previous;
      await saveModelOverride(model.id, { ...rest, ...(value.trim() ? { contextWindow: Number(value.trim()) } : {}) });
    } else await saveModelOverride(model.id, undefined);
    this.refresh();
    void vscode.window.showInformationMessage('Model settings saved for future requests. Start a new chat if Copilot retains an old context budget.');
  }
  async provideLanguageModelChatResponse(modelInfo: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: NativeResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
    const config = settings(); const cancel = cancellation(token);
    const operation = deadline(config.timeoutMs, [cancel.signal, this.accounts.signal]);
    let requestScope: string | undefined;
    try {
      const credentials = await this.accounts.credentials(operation.signal);
      requestScope = JSON.stringify([credentials.clientId, credentials.epoch]);
      this.checkQuotaPause(requestScope);
      const models = await this.models(credentials, operation.signal);
      const model = models.find(item => editorId(item.id) === modelInfo.id);
      if (!model) throw new AppError('The selected model is not available for the current account. Refresh the model list.', 'permission');
      const effort = reasoningEffort(model, pickerEffort(options), config.effort);
      const budget = pickerInputBudget(model, options);
      const normalized = messages.map(normalizeMessage);
      const replayScope = JSON.stringify([credentials.clientId, credentials.epoch, model.id]);
      const prepared = this.replay.apply(replayScope, prepareRequest(model, normalized, (options.tools ?? []).map(tool => ({
        name: tool.name, description: tool.description, schema: tool.inputSchema ?? { type: 'object', properties: {} }
      })), options.toolMode === vscode.LanguageModelChatToolMode.Required, effort, config.summary,
      `${this.session}-${createHash('sha256').update(credentials.clientId + credentials.epoch).digest('hex').slice(0, 16)}`));
      if (estimateTokens(normalized) + estimateTokens(String(prepared.body.instructions)) +
        estimateTokens(JSON.stringify(prepared.body.tools ?? [])) + 64 > budget) {
        throw new AppError('The conversation exceeds the effective input context budget. Start a new chat or select a larger budget. No history was dropped.');
      }
      let summary = false; let answer = false;
      let markdown = new MathMarkdownStream(); let channel: 'text' | 'summary' | undefined;
      const reportText = (value: string) => {
        if (value) { checkAbort(operation.signal); progress.report(new vscode.LanguageModelTextPart(value)); }
      };
      const result = await complete(this.http, credentials.access, prepared, operation.signal, (type, value) => {
        checkAbort(operation.signal);
        if (type === 'summary' && !config.summary) return;
        if (channel !== type) {
          reportText(markdown.finish()); markdown = new MathMarkdownStream(); channel = type;
        }
        if (type === 'summary') {
          if (!summary) reportText('\n\n**Reasoning summary**\n\n');
          summary = true;
        } else if (!answer) {
          if (summary) reportText('\n\n---\n\n');
          answer = true;
        }
        reportText(markdown.push(value));
      }, config.timeoutMs, info => {
        this.log.info(`Responses transport: HTTP ${info.status}; Content-Type: ${info.contentType}; request ID: ${info.requestId ?? 'unavailable'}.`);
      }).finally(() => {
        // Preserve a literal incomplete tail on transport failure, but never emit after cancellation.
        if (!operation.signal.aborted) reportText(markdown.finish());
      });
      checkAbort(operation.signal);
      this.replay.remember(replayScope, result.replay);
      const usage = copilotUsagePart(result);
      if (usage) progress.report(usage);
      else this.log.info('Token usage was not reported: complete, valid input/output counts were unavailable. No zero usage was fabricated.');
      for (const call of result.tools) {
        checkAbort(operation.signal); progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, call.input));
      }
      this.log.info(`Request completed; input tokens: ${result.inputTokens ?? 'unknown'}; output tokens: ${result.outputTokens ?? 'unknown'}; tool calls: ${result.tools.length}.`);
    } catch (error) { throw this.translate(this.pauseQuota(requestScope, error)); }
    finally { operation.dispose(); cancel.dispose(); }
  }
  async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return estimateTokens(typeof value === 'string' ? value : [normalizeMessage(value)]);
  }
  private translate(error: unknown): Error {
    const safe = safeError(error); this.log.warn(`${safe.kind}: ${safe.message}${safe.status !== undefined ? ` [upstream HTTP ${safe.status}]` : ''}`);
    if (safe.kind === 'cancelled') return new vscode.CancellationError();
    if (safe.kind === 'auth' || safe.kind === 'permission') return vscode.LanguageModelError.NoPermissions(safe.message);
    if (safe.kind === 'quota') return vscode.LanguageModelError.Blocked(safe.message);
    return safe;
  }
  dispose(): void { this.replay.clear(); this.quotaPauses.clear(); this.changes.dispose(); }
}
