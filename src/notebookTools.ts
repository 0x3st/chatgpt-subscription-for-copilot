import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export const NOTEBOOK_TOOLS = {
  list: 'chatgptSub_notebookList', read: 'chatgptSub_notebookReadCell', update: 'chatgptSub_notebookUpdateCell'
} as const;
export const NOTEBOOK_LOCK_COMMAND = 'chatgptSub.toggleNotebookCellLock';
const TYPE = 'jupyter-notebook';
const PAGE_SIZE = 100;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SNAPSHOTS = 256;
const SNAPSHOT_TTL = 15 * 60 * 1000;

interface ListInput { notebookUri?: string; offset?: number }
interface CellInput { notebookUri: string; cellId: string }
interface UpdateInput extends CellInput { snapshotId: string; newText: string }
interface Snapshot {
  notebook: vscode.NotebookDocument; cell: vscode.NotebookCell; document: vscode.TextDocument;
  version: number; hash: string; language: string; expires: number;
}
type Result = { ok: boolean; [key: string]: unknown };
const failure = (code: string, message: string): Result => ({ ok: false, code, message });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const validString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192;

/** Open editor documents only. No filesystem, kernel, credentials, or model calls. */
export class NotebookLiveEdit implements vscode.Disposable {
  private ids = new WeakMap<vscode.NotebookCell, string>();
  private locked = new WeakSet<vscode.NotebookCell>();
  private snapshots = new Map<string, Snapshot>();
  private pending = new Set<vscode.NotebookCell>();
  private disposed = false;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changes.event;
  private readonly closeListener = vscode.workspace.onDidCloseNotebookDocument(notebook => {
    for (const [id, snapshot] of this.snapshots) if (snapshot.notebook === notebook) this.snapshots.delete(id);
    // Cell URIs may be reused after reopening. Never reuse our old identities or locks.
    for (const cell of notebook.getCells()) { this.ids.delete(cell); this.locked.delete(cell); }
    this.changes.fire();
  });

  constructor(private readonly now: () => number = Date.now) {}

  private guard(token: vscode.CancellationToken): Result | undefined {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (this.disposed) return failure('unavailable', 'Notebook tools have been disposed.');
    if (!vscode.workspace.isTrusted) return failure('untrusted_workspace', 'Notebook tools require a trusted workspace.');
    return undefined;
  }
  private notebooks(): vscode.NotebookDocument[] {
    return vscode.workspace.notebookDocuments.filter(notebook => !notebook.isClosed && notebook.notebookType === TYPE);
  }
  private notebook(uri: string): vscode.NotebookDocument | undefined {
    return this.notebooks().find(notebook => notebook.uri.toString() === uri);
  }
  private target(input: CellInput): vscode.NotebookCell | undefined {
    if (!input || !validString(input.notebookUri) || !validString(input.cellId)) return undefined;
    return this.notebook(input.notebookUri)?.getCells().find(cell => this.ids.get(cell) === input.cellId && !cell.document.isClosed);
  }
  private id(cell: vscode.NotebookCell): string {
    let id = this.ids.get(cell);
    if (!id) { id = randomUUID(); this.ids.set(cell, id); }
    return id;
  }
  private invalidate(cell: vscode.NotebookCell): void {
    for (const [id, snapshot] of this.snapshots) if (snapshot.cell === cell) this.snapshots.delete(id);
  }
  private prune(): void {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expires <= now || snapshot.notebook.isClosed || snapshot.document.isClosed ||
        !vscode.workspace.notebookDocuments.includes(snapshot.notebook) || !snapshot.notebook.getCells().includes(snapshot.cell)) this.snapshots.delete(id);
    }
  }

  list(input: ListInput, token: vscode.CancellationToken): Result {
    const blocked = this.guard(token); if (blocked) return blocked;
    if (!input || (input.notebookUri !== undefined && !validString(input.notebookUri)) ||
      (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > Number.MAX_SAFE_INTEGER - PAGE_SIZE))) return failure('invalid_input', 'Provide a valid notebook URI and non-negative page offset.');
    const offset = input.offset ?? 0;
    if (!input.notebookUri) {
      const notebooks = this.notebooks();
      return { ok: true, notebooks: notebooks.slice(offset, offset + PAGE_SIZE).map(notebook => ({
        notebookUri: notebook.uri.toString(), cellCount: notebook.cellCount, dirty: notebook.isDirty
      })), total: notebooks.length, nextOffset: offset + PAGE_SIZE < notebooks.length ? offset + PAGE_SIZE : null };
    }
    const notebook = this.notebook(input.notebookUri);
    if (!notebook) return failure('not_open', 'The Jupyter notebook is not open. Ask the user to open it, then list again.');
    return { ok: true, notebookUri: input.notebookUri, cells: notebook.getCells(new vscode.NotebookRange(offset, offset + PAGE_SIZE)).map(cell => ({
      cellId: this.id(cell), index: cell.index, kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
      language: cell.document.languageId, version: cell.document.version, locked: this.locked.has(cell)
    })), total: notebook.cellCount, nextOffset: offset + PAGE_SIZE < notebook.cellCount ? offset + PAGE_SIZE : null };
  }

  read(input: CellInput, token: vscode.CancellationToken): Result {
    const blocked = this.guard(token); if (blocked) return blocked;
    const cell = this.target(input);
    if (!cell) return failure('target_missing', 'The cell is not in the specified open notebook. List cells again; never substitute a cell index.');
    const text = cell.document.getText();
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) return failure('source_too_large', 'This cell exceeds the 256 KiB source limit. No truncated snapshot was issued.');
    this.prune();
    while (this.snapshots.size >= MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
    const snapshotId = randomUUID();
    this.snapshots.set(snapshotId, { notebook: cell.notebook, cell, document: cell.document, version: cell.document.version,
      hash: hash(text), language: cell.document.languageId, expires: this.now() + SNAPSHOT_TTL });
    return { ok: true, notebookUri: input.notebookUri, cellId: input.cellId, index: cell.index, language: cell.document.languageId,
      version: cell.document.version, locked: this.locked.has(cell), snapshotId, source: text };
  }

  async update(input: UpdateInput, token: vscode.CancellationToken): Promise<Result> {
    const blocked = this.guard(token); if (blocked) return blocked;
    if (!input || !validString(input.snapshotId) || typeof input.newText !== 'string') return failure('invalid_input', 'Provide a read snapshot and replacement source.');
    if (Buffer.byteLength(input.newText, 'utf8') > MAX_SOURCE_BYTES) return failure('source_too_large', 'Replacement source exceeds 256 KiB.');
    const cell = this.target(input);
    if (!cell) return failure('target_missing', 'The cell is no longer open at this identity. List and read again.');
    if (this.locked.has(cell)) return failure('cell_locked', 'The user locked this cell against this extension\'s AI edits. Do not bypass the lock with another tool.');
    if (this.pending.has(cell)) return failure('edit_pending', 'An edit is already pending for this cell. Wait for its result, then read again.');
    this.prune();
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot || snapshot.cell !== cell || snapshot.notebook !== cell.notebook || snapshot.document !== cell.document) {
      return failure('stale_snapshot', 'Snapshot expired or does not belong to this open cell. Read the cell again.');
    }
    const document = cell.document;
    const oldText = document.getText();
    if (snapshot.version !== document.version || snapshot.language !== document.languageId || snapshot.hash !== hash(oldText)) {
      this.invalidate(cell);
      return failure('conflict', 'The cell changed since it was read. No edit was submitted. Read again and reconcile the latest source.');
    }
    this.invalidate(cell); // One-shot, including rejected/uncertain applyEdit outcomes.
    if (oldText === input.newText) return { ok: true, applied: false, unchanged: true, cellId: input.cellId, version: document.version };
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(oldText.length)), input.newText);
    this.pending.add(cell);
    try {
      // No await between final validation and submission. VS Code owns the actual
      // text-edit transaction; the public API does not expose a caller-supplied CAS version.
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) return failure('edit_rejected', 'VS Code rejected the edit. Read the cell again before retrying.');
      // Cancellation after submission cannot retract an editor transaction. Report
      // the actual result, not a false cancellation/failure that could cause a retry.
      return { ok: true, applied: true, cellId: input.cellId, version: document.version, readAgainBeforeNextEdit: true,
        message: 'Cell source updated in the live editor document. No save or execution was requested; VS Code Auto Save may still save it.' };
    } catch {
      return failure('edit_failed', 'The editor edit did not return a reliable result. Read the live cell to determine its state; do not retry the old snapshot.');
    } finally { this.pending.delete(cell); }
  }

  toggleLock(candidate?: vscode.NotebookCell): void {
    if (this.disposed || !vscode.workspace.isTrusted) return;
    const editor = vscode.window.activeNotebookEditor;
    const cell = candidate ?? (editor && editor.notebook.cellCount > 0 ? editor.notebook.cellAt(editor.selection.start) : undefined);
    if (!cell || !this.notebooks().includes(cell.notebook) || !cell.notebook.getCells().includes(cell)) {
      void vscode.window.showWarningMessage('Select a cell in an open Jupyter notebook.'); return;
    }
    if (this.pending.has(cell)) {
      void vscode.window.showWarningMessage('A cell edit has already been submitted. Wait for it to finish, then change the AI lock.'); return;
    }
    if (this.locked.has(cell)) this.locked.delete(cell); else this.locked.add(cell);
    this.invalidate(cell); this.changes.fire();
  }

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    if (this.disposed || !vscode.workspace.isTrusted || cell.notebook.notebookType !== TYPE) return [];
    const locked = this.locked.has(cell);
    const item = new vscode.NotebookCellStatusBarItem(locked ? '$(lock) AI locked' : '$(unlock) AI editable', vscode.NotebookCellStatusBarAlignment.Right);
    item.command = { command: NOTEBOOK_LOCK_COMMAND, title: 'Toggle AI Cell Lock', arguments: [cell] };
    item.tooltip = 'Toggle protection against this extension\'s notebook update tool. Does not block typing, other tools, or disk writes. Locks reset when the notebook closes.';
    return [item];
  }

  dispose(): void {
    this.disposed = true; this.snapshots.clear(); this.pending.clear();
    this.ids = new WeakMap(); this.locked = new WeakSet(); this.closeListener.dispose(); this.changes.dispose();
  }
}

export function registerNotebookTools(context: vscode.ExtensionContext): void {
  const editor = new NotebookLiveEdit();
  const result = (value: Result) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value))]);
  context.subscriptions.push(editor,
    vscode.commands.registerCommand(NOTEBOOK_LOCK_COMMAND, (cell?: vscode.NotebookCell) => editor.toggleLock(cell)),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(TYPE, editor),
    vscode.lm.registerTool<ListInput>(NOTEBOOK_TOOLS.list, {
      prepareInvocation: () => ({ invocationMessage: 'List open notebook editor documents' }),
      invoke: (options, token) => result(editor.list(options.input, token))
    }),
    vscode.lm.registerTool<CellInput>(NOTEBOOK_TOOLS.read, {
      prepareInvocation: () => ({ invocationMessage: 'Read live notebook cell source', confirmationMessages: {
        title: 'Read notebook cell', message: 'Read one open cell, including unsaved source, and return it to Copilot and the selected model.'
      } }),
      invoke: (options, token) => result(editor.read(options.input, token))
    }),
    vscode.lm.registerTool<UpdateInput>(NOTEBOOK_TOOLS.update, {
      prepareInvocation: options => ({ invocationMessage: 'Update live notebook cell source', confirmationMessages: {
        title: 'Update notebook cell', message: `Replace the source of cell ${options.input.cellId} in the open notebook ${options.input.notebookUri}. The read snapshot and user lock are rechecked after approval. No save, execution, output, or metadata change is requested; VS Code Auto Save may still persist the edit.`
      } }),
      invoke: async (options, token) => result(await editor.update(options.input, token))
    }));
}
