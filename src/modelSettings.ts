import * as vscode from 'vscode';
import { AppError, record } from './core';
import { EFFORTS, type ChatModel, type Effort } from './chat/models';

export interface ModelOverride { reasoningEffort?: Effort | 'default'; contextWindow?: number }
export const MAX_CONTEXT_OVERRIDE = 2_000_000;
export function userSetting(key: string): unknown {
  const value = vscode.workspace.getConfiguration('chatgptSub').inspect<unknown>(key);
  return value?.globalValue !== undefined ? value.globalValue : value?.defaultValue;
}
function overrides(): Record<string, unknown> {
  const value = userSetting('modelOverrides');
  if (value === undefined) return {};
  const result = record(value);
  if (!result) throw new AppError('Invalid modelOverrides setting: expected an object.');
  return result;
}
export function modelOverride(id: string): ModelOverride {
  const entries = overrides();
  if (!Object.hasOwn(entries, id)) return {};
  const value = record(entries[id]);
  if (!value || Object.keys(value).some(key => !['reasoningEffort', 'contextWindow'].includes(key))) {
    throw new AppError('Invalid model override. Only reasoningEffort and contextWindow are supported.');
  }
  const effort = value.reasoningEffort; const context = value.contextWindow;
  if (effort !== undefined && effort !== 'default' && !EFFORTS.includes(effort as Effort)) throw new AppError('Invalid per-model reasoning effort.');
  if (context !== undefined && (typeof context !== 'number' || !Number.isSafeInteger(context) || context < 1024 || context > MAX_CONTEXT_OVERRIDE)) {
    throw new AppError('Invalid context window override. Use an integer from 1024 to 2000000 tokens.');
  }
  return { ...(effort !== undefined ? { reasoningEffort: effort as Effort | 'default' } : {}),
    ...(context !== undefined ? { contextWindow: context as number } : {}) };
}
export function inputBudget(model: ChatModel, override = modelOverride(model.id)): number {
  if (override.contextWindow === undefined) return model.inputTokens;
  // Only missing catalog metadata may be replaced; a declared server limit cannot be increased.
  return model.estimatedInputLimit === true ? override.contextWindow : Math.min(model.inputTokens, override.contextWindow);
}
export function reasoningEffort(model: ChatModel, option: unknown, fallback: Effort | undefined): Effort | undefined {
  if (option !== undefined && option !== 'default' && !EFFORTS.includes(option as Effort)) throw new AppError('Invalid reasoning effort.');
  const choice = option !== undefined ? option : modelOverride(model.id).reasoningEffort ?? fallback;
  if (choice === undefined || choice === 'default') return undefined;
  if (!EFFORTS.includes(choice as Effort)) throw new AppError('Invalid reasoning effort.');
  if (model.efforts.length && !model.efforts.includes(choice as Effort)) {
    throw new AppError('This model has not declared support for the selected reasoning effort. Select default or another supported effort.');
  }
  return choice as Effort;
}
export function contextWindowError(model: ChatModel, value: string): string | undefined {
  if (!value.trim()) return undefined;
  const limit = model.estimatedInputLimit === true ? MAX_CONTEXT_OVERRIDE : Math.min(MAX_CONTEXT_OVERRIDE, model.inputTokens);
  const number = Number(value.trim());
  if (!/^[0-9]+$/.test(value.trim()) || !Number.isSafeInteger(number) || number < 1024 || number > limit) {
    return `Enter an integer from 1024 to ${limit} tokens, or leave blank for the model default.`;
  }
  return undefined;
}
export async function saveModelOverride(id: string, value: ModelOverride | undefined): Promise<void> {
  const entries = { ...overrides() };
  if (value && Object.keys(value).length) Object.defineProperty(entries, id, { value, enumerable: true, configurable: true, writable: true });
  else delete entries[id];
  await vscode.workspace.getConfiguration('chatgptSub').update('modelOverrides', entries, vscode.ConfigurationTarget.Global);
}
