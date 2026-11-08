export class EventEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
  dispose(): void { this.listeners.clear(); }
}
export class LanguageModelTextPart { constructor(public value: string) {} }
export class LanguageModelToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
export class LanguageModelToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
export class LanguageModelDataPart { constructor(public data: Uint8Array, public mimeType: string) {} }
export enum LanguageModelChatMessageRole { User = 1, Assistant = 2 }
export enum LanguageModelChatToolMode { Auto = 1, Required = 2 }
export class CancellationError extends Error { constructor() { super('Cancelled'); this.name = 'Canceled'; } }
export class LanguageModelError extends Error {
  static NoPermissions(message: string): Error { const result = new Error(message); result.name = 'NoPermissions'; return result; }
  static Blocked(message: string): Error { const result = new Error(message); result.name = 'Blocked'; return result; }
}
export const configuration: Record<string, { globalValue?: unknown; defaultValue?: unknown; workspaceValue?: unknown }> = {};
export const workspace = { getConfiguration: () => ({ inspect: (key: string) => configuration[key] }) };
export const registeredCommands = new Map<string, () => unknown>();
export const registeredProviders = new Map<string, unknown>();
export let browserOpens = 0;
export const commands = { registerCommand: (name: string, action: () => unknown) => {
  registeredCommands.set(name, action); return { dispose: () => { registeredCommands.delete(name); } };
} };
export const lm = { registerLanguageModelChatProvider: (name: string, provider: unknown) => {
  registeredProviders.set(name, provider); return { dispose: () => { registeredProviders.delete(name); } };
} };
export const window = {
  createOutputChannel: () => ({ info() {}, warn() {}, show() {}, dispose() {} }),
  showErrorMessage: async () => undefined, showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined, showQuickPick: async () => undefined
};
export const Uri = { parse: (url: string) => new URL(url) };
export enum UIKind { Desktop = 1, Web = 2 }
export const env = { uiKind: UIKind.Desktop, openExternal: async () => { browserOpens++; return false; } };
export const ProgressLocation = { Notification: 15 };
