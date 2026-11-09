import type * as VSCode from 'vscode';

export class EventEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
  dispose(): void { this.listeners.clear(); }
}
export class LanguageModelTextPart { constructor(public value: string) {} }
export class LanguageModelToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
export class LanguageModelToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
export class LanguageModelToolResult { constructor(public content: unknown[]) {} }
export class Position { constructor(public line: number, public character: number) {} }
export class Range { constructor(public start: VSCode.Position, public end: VSCode.Position) {} }
export class NotebookRange { constructor(public start: number, public end: number) {} }
export enum NotebookCellKind { Markup = 1, Code = 2 }
export enum NotebookCellStatusBarAlignment { Left = 1, Right = 2 }
export class NotebookCellStatusBarItem {
  command?: VSCode.Command | string; tooltip?: string;
  constructor(public text: string, public alignment: NotebookCellStatusBarAlignment) {}
}
export class WorkspaceEdit {
  edits: { uri: VSCode.Uri; range: VSCode.Range; newText: string }[] = [];
  replace(uri: VSCode.Uri, range: VSCode.Range, newText: string): void { this.edits.push({ uri, range, newText }); }
}
export class LanguageModelDataPart { constructor(public data: Uint8Array, public mimeType: string) {} }
export enum LanguageModelChatMessageRole { User = 1, Assistant = 2 }
export enum LanguageModelChatToolMode { Auto = 1, Required = 2 }
export class CancellationError extends Error { constructor() { super('Cancelled'); this.name = 'Canceled'; } }
export class LanguageModelError extends Error {
  static NoPermissions(message: string): Error { const result = new Error(message); result.name = 'NoPermissions'; return result; }
  static Blocked(message: string): Error { const result = new Error(message); result.name = 'Blocked'; return result; }
}
export const configuration: Record<string, { globalValue?: unknown; defaultValue?: unknown; workspaceValue?: unknown }> = {};
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
const configurationChanges = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
export const notebookClosed = new EventEmitter<VSCode.NotebookDocument>();
export const workspace = {
  isTrusted: true,
  notebookDocuments: [] as VSCode.NotebookDocument[],
  onDidCloseNotebookDocument: notebookClosed.event,
  applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => false,
  onDidChangeConfiguration: configurationChanges.event,
  getConfiguration: () => ({ inspect: (key: string) => configuration[key],
    update: async (key: string, value: unknown, target: ConfigurationTarget) => {
      if (target !== ConfigurationTarget.Global) throw new Error('Expected user settings only');
      configuration[key] = { ...configuration[key], globalValue: value };
      configurationChanges.fire({ affectsConfiguration: section => section === 'chatgptSub' });
    }
  })
};
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
export const registeredProviders = new Map<string, unknown>();
export let browserOpens = 0;
export const commands = { registerCommand: <T extends unknown[]>(name: string, action: (...args: T) => unknown) => {
  registeredCommands.set(name, (...args) => action(...args as T)); return { dispose: () => { registeredCommands.delete(name); } };
} };
export const registeredTools = new Map<string, VSCode.LanguageModelTool<unknown>>();
export const notebookStatusProviders = new Map<string, VSCode.NotebookCellStatusBarItemProvider>();
export const notebooks = { registerNotebookCellStatusBarItemProvider: (type: string, provider: VSCode.NotebookCellStatusBarItemProvider) => {
  notebookStatusProviders.set(type, provider); return { dispose: () => { notebookStatusProviders.delete(type); } };
} };
export const nativeModelChanges = new EventEmitter<void>();
export const installedExtensions = new Map<string, { isActive: boolean }>();
export const extensions = { getExtension: (id: string) => installedExtensions.get(id) };
export const lm = { registerTool: <T>(name: string, tool: VSCode.LanguageModelTool<T>) => {
  registeredTools.set(name, tool); return { dispose: () => { registeredTools.delete(name); } };
}, onDidChangeChatModels: nativeModelChanges.event, registerLanguageModelChatProvider: (name: string, provider: unknown) => {
  registeredProviders.set(name, provider); return { dispose: () => { registeredProviders.delete(name); } };
} };
export const window = {
  activeNotebookEditor: undefined as VSCode.NotebookEditor | undefined,
  createOutputChannel: () => ({ info() {}, warn() {}, show() {}, dispose() {} }),
  showErrorMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
  showWarningMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
  showInformationMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
  showQuickPick: async (_items: unknown, _options?: unknown): Promise<unknown> => undefined,
  showInputBox: async (_options?: unknown): Promise<string | undefined> => undefined,
  withProgress: async (_options: unknown, _task: (progress: unknown, token: {
    isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void };
  }) => PromiseLike<unknown>): Promise<unknown> => { throw new CancellationError(); }
};
export const Uri = { parse: (url: string) => new URL(url) };
export enum UIKind { Desktop = 1, Web = 2 }
export const env = { uiKind: UIKind.Desktop, openExternal: async () => { browserOpens++; return false; } };
export const ProgressLocation = { Notification: 15 };
