import * as vscode from 'vscode';
import { AppError, record } from './core';
import { EFFORTS, type ChatModel, type Effort } from './chat/models';
import { inputBudget, modelOverride } from './modelSettings';

// Compatibility metadata consumed by Copilot, not a public VS Code API contract.
// Keep the stable provider registration and do not enable proposed APIs.
export interface PickerProperty {
  type: 'string' | 'number'; title: string; enum: (string | number)[];
  enumItemLabels: string[]; enumDescriptions: string[]; default: string | number;
  group: 'navigation' | 'tokens';
}
export interface NativeModelInformation extends vscode.LanguageModelChatInformation {
  configurationSchema: { properties: Record<string, PickerProperty> };
}
export type NativeResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Readonly<Record<string, unknown>>;
  readonly configuration?: Readonly<Record<string, unknown>>;
};
const EFFORT_LABELS: Record<Effort | 'default', string> = {
  default: 'Default', none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max'
};
const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export function pickerSchema(model: ChatModel, globalEffort: Effort | undefined): NativeModelInformation['configurationSchema'] {
  const override = modelOverride(model.id);
  const effort = override.reasoningEffort ?? globalEffort ?? 'default';
  const levels = model.efforts.length ? model.efforts : [...EFFORTS];
  const values = ['inherit', 'default', ...levels];
  const properties: Record<string, PickerProperty> = {
    reasoningEffort: {
      type: 'string', title: 'Thinking effort', enum: values,
      enumItemLabels: ['Use saved setting', 'Default', ...levels.map(value => EFFORT_LABELS[value])],
      enumDescriptions: ['Use the extension per-model or global preference.', 'Let OpenAI choose the reasoning effort.',
        ...levels.map(() => model.efforts.length ? 'Supported by this model according to the account catalog.' : 'Capabilities were not reported; OpenAI may reject an explicit effort.')],
      // An unsupported saved effort must still fail closed, not silently become a different effort.
      default: values.includes(effort) ? effort : 'inherit', group: 'navigation'
    }
  };
  const ceiling = inputBudget(model, override);
  if (ceiling >= 1024) {
    const sizes = [...new Set([1024, 16000, 32000, 64000, 128000, 256000, 512000, 1000000, 2000000, ceiling])]
      .filter(value => value <= ceiling).sort((a, b) => a - b);
    properties.contextSize = {
      type: 'number', title: 'Context window', enum: sizes,
      enumItemLabels: sizes.map(value => `${value === ceiling ? 'Max ' : ''}${compact(value)}`),
      enumDescriptions: sizes.map(value => `${value.toLocaleString('en-US')} input tokens for Copilot. ${model.estimatedInputLimit ? 'The catalog input limit is estimated or user-supplied; this does not increase server capacity.' : 'The catalog input limit is respected.'}`),
      default: ceiling, group: 'tokens'
    };
  }
  return { properties };
}

export function pickerOption(options: NativeResponseOptions, key: 'reasoningEffort' | 'contextSize'): unknown {
  for (const carrier of [options.modelOptions, options.modelConfiguration, options.configuration]) {
    if (carrier === undefined || carrier === null) continue;
    const values = record(carrier);
    if (!values) throw new AppError('Invalid model configuration.');
    if (Object.hasOwn(values, key) && values[key] !== undefined) return values[key];
  }
  return undefined;
}
export function pickerEffort(options: NativeResponseOptions): unknown {
  const value = pickerOption(options, 'reasoningEffort');
  return value === 'inherit' ? undefined : value;
}
export function pickerInputBudget(model: ChatModel, options: NativeResponseOptions): number | undefined {
  const value = pickerOption(options, 'contextSize');
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1024 || value > inputBudget(model)) {
    throw new AppError('The selected context budget is invalid or exceeds the current model input limit. Re-select a context size in the model menu.');
  }
  return value;
}

// Observe activation passively; do not activate Copilot, open a browser, or poll.
export function refreshNativePicker(refresh: () => void, signal: AbortSignal): vscode.Disposable {
  let done = false; let pending: ReturnType<typeof setImmediate> | undefined;
  const check = () => {
    if (!done && !signal.aborted && vscode.extensions.getExtension('github.copilot-chat')?.isActive) {
      done = true; refresh();
    }
  };
  const changed = () => {
    check();
    // Model registration can fire just before VS Code marks activation complete.
    // One deferred check per event handles that race without a polling loop.
    if (!done && !signal.aborted && pending === undefined) pending = setImmediate(() => { pending = undefined; check(); });
  };
  const subscription = vscode.lm.onDidChangeChatModels(changed);
  queueMicrotask(changed);
  return { dispose() { done = true; if (pending !== undefined) clearImmediate(pending); subscription.dispose(); } };
}
