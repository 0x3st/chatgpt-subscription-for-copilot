import * as vscode from 'vscode';
import { isAbsolute } from 'node:path';
import { AppError } from './core';
import type { Content, Message, Part } from './chat/request';
import type { TokenUsage } from './chat/client';

/** Non-public Copilot compatibility payload carried by the stable DataPart API. */
export function copilotUsagePart(usage: TokenUsage): vscode.LanguageModelDataPart | undefined {
  const { inputTokens: input, outputTokens: output, cachedInputTokens: cached } = usage;
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 ||
    typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(input + output)) return undefined;
  const data = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    ...(typeof cached === 'number' && Number.isSafeInteger(cached) && cached >= 0 && cached <= input
      ? { prompt_tokens_details: { cached_tokens: cached } } : {}) };
  return new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(data)), 'usage');
}
/** Desktop profiles can expose local storage through vscode-userdata:, not just file:. */
export function localStorageDirectory(uri: vscode.Uri, uiKind: vscode.UIKind): string {
  if (uiKind !== vscode.UIKind.Desktop || !['file', 'vscode-userdata'].includes(uri.scheme) || uri.authority || !isAbsolute(uri.fsPath)) {
    throw new AppError('ChatGPT Subscription requires a desktop extension host and local user storage.', 'permission');
  }
  return uri.fsPath;
}
function content(part: unknown): Content | undefined {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
  if (part instanceof vscode.LanguageModelDataPart) {
    if (part.mimeType.startsWith('image/')) return { type: 'image', mime: part.mimeType, data: part.data };
    if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') {
      try { return { type: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(part.data) }; }
      catch { throw new AppError('The text attachment is not valid UTF-8.'); }
    }
    throw new AppError(`Unsupported attachment type. Use text or images.`);
  }
  return undefined;
}
export function normalizeMessage(message: vscode.LanguageModelChatRequestMessage): Message {
  const parts: Part[] = [];
  for (const raw of message.content) {
    const item = content(raw);
    if (item) parts.push(item);
    else if (raw instanceof vscode.LanguageModelToolCallPart) parts.push({ type: 'call', id: raw.callId, name: raw.name, input: raw.input });
    else if (raw instanceof vscode.LanguageModelToolResultPart) {
      const values = raw.content.map(value => {
        const normalized = content(value); if (!normalized) throw new AppError('The tool result contains unsupported content. Context has not been silently discarded.');
        return normalized;
      });
      parts.push({ type: 'result', id: raw.callId, content: values });
    } else throw new AppError('The conversation contains an unsupported message type. Context has not been silently discarded.');
  }
  return { role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', parts };
}
export function cancellation(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const sub = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  return { signal: controller.signal, dispose() { sub.dispose(); controller.abort(); } };
}
