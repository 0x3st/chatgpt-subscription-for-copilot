import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as vscode from 'vscode';
import { NotebookLiveEdit, NOTEBOOK_TOOLS, NOTEBOOK_LOCK_COMMAND, registerNotebookTools } from '../src/notebookTools';
import * as api from './vscode.mock';
import { deferred } from './helpers';

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const cancelled = { ...token, isCancellationRequested: true };
const uri = (value: string) => ({ toString: () => value }) as vscode.Uri;

function fixture(sources = ['unsaved user input', 'old AI target', '# notes'], notebookUri = 'file:///work/demo.ipynb') {
  const cells: vscode.NotebookCell[] = [];
  const documents: { text: string; version: number; languageId: string; isClosed: boolean }[] = [];
  const state = { closed: false, saves: 0, dirty: true };
  const notebook = {
    uri: uri(notebookUri), notebookType: 'jupyter-notebook', get isClosed() { return state.closed; },
    get isDirty() { return state.dirty; }, get cellCount() { return cells.length; },
    getCells: (range?: vscode.NotebookRange) => range ? cells.slice(range.start, range.end) : [...cells],
    cellAt: (index: number) => cells[Math.max(0, Math.min(cells.length - 1, index))],
    save: async () => { state.saves++; return true; }
  } as unknown as vscode.NotebookDocument;
  sources.forEach((source, i) => {
    const text = { text: source, version: 1, languageId: 'python', isClosed: false };
    documents.push(text);
    const document = {
      uri: uri(`vscode-notebook-cell:${notebookUri}#${i}`),
      get version() { return text.version; }, get isClosed() { return text.isClosed; }, get languageId() { return text.languageId; },
      getText: () => text.text,
      positionAt: (offset: number) => {
        const lines = text.text.slice(0, offset).split('\n');
        return new api.Position(lines.length - 1, lines.at(-1)!.length);
      }
    } as unknown as vscode.TextDocument;
    const cell = { notebook, document, kind: i === 2 ? api.NotebookCellKind.Markup : api.NotebookCellKind.Code,
      metadata: { custom: true }, outputs: [{ output: 'retained' }], get index() { return cells.indexOf(cell); }
    } as unknown as vscode.NotebookCell;
    cells.push(cell);
  });
  return { cells, documents, notebook, state };
}

function setup(sources?: string[], now?: () => number) {
  const data = fixture(sources);
  const originalApply = api.workspace.applyEdit;
  api.workspace.notebookDocuments = [data.notebook]; api.workspace.isTrusted = true;
  const edits: api.WorkspaceEdit[] = [];
  api.workspace.applyEdit = async edit => {
    edits.push(edit);
    for (const item of edit.edits) {
      const index = data.cells.findIndex(cell => cell.document.uri.toString() === item.uri.toString());
      assert.notEqual(index, -1);
      const cell = data.cells[index]!; const sourceIndex = Number(cell.document.uri.toString().split('#').at(-1));
      data.documents[sourceIndex]!.text = item.newText; data.documents[sourceIndex]!.version++;
    }
    return true;
  };
  const service = new NotebookLiveEdit(now);
  const listing = service.list({ notebookUri: data.notebook.uri.toString() }, token);
  const listed = listing.cells as { cellId: string; locked: boolean }[];
  const input = (index = 1) => ({ notebookUri: data.notebook.uri.toString(), cellId: listed[index]!.cellId });
  const snapshot = (index = 1) => {
    const result = service.read(input(index), token); assert.equal(result.ok, true);
    return { ...input(index), snapshotId: result.snapshotId as string, newText: 'new AI source' };
  };
  return { ...data, service, edits, listed, input, snapshot, cleanup: () => {
    service.dispose(); api.workspace.notebookDocuments = []; api.workspace.applyEdit = originalApply;
    api.workspace.isTrusted = true; api.window.activeNotebookEditor = undefined;
  } };
}

const codes = (result: { [key: string]: unknown }, code: string) => { assert.equal(result.ok, false); assert.equal(result.code, code); };

test('list/read use live unsaved editor source and source is never truncated', () => {
  const f = setup();
  try {
    const notebooks = f.service.list({}, token).notebooks as { notebookUri: string; dirty: boolean }[];
    assert.deepEqual(notebooks, [{ notebookUri: f.notebook.uri.toString(), cellCount: 3, dirty: true }]);
    const read = f.service.read(f.input(0), token);
    assert.equal(read.source, 'unsaved user input'); assert.equal(read.version, 1); assert.equal(read.locked, false);
    assert.equal(typeof read.snapshotId, 'string'); assert.equal(f.state.saves, 0); assert.equal(f.edits.length, 0);
    f.documents[0]!.text = 'x'.repeat(256 * 1024 + 1);
    const tooBig = f.service.read(f.input(0), token); codes(tooBig, 'source_too_large'); assert.ok(!('snapshotId' in tooBig));
  } finally { f.cleanup(); }
});

test('update targets one live Cell TextDocument, preserving other unsaved cells, outputs and metadata without saving', async () => {
  const f = setup(['draft from user\n第二行', 'old\nsource', '# notes']);
  try {
    const output = f.cells[1]!.outputs; const metadata = f.cells[1]!.metadata;
    const input = { ...f.snapshot(), newText: 'print("你好 🌏")\n' };
    f.documents[0]!.text = 'user is still typing'; f.documents[0]!.version++;
    const result = await f.service.update(input, token);
    assert.equal(result.ok, true); assert.equal(result.applied, true);
    assert.equal(f.documents[1]!.text, input.newText); assert.equal(f.documents[0]!.text, 'user is still typing');
    assert.equal(f.documents[2]!.text, '# notes'); assert.equal(f.state.saves, 0);
    assert.equal(f.cells[1]!.outputs, output); assert.equal(f.cells[1]!.metadata, metadata);
    assert.equal(f.edits.length, 1); assert.equal(f.edits[0]!.edits.length, 1);
    const edit = f.edits[0]!.edits[0]!;
    assert.equal(edit.uri, f.cells[1]!.document.uri);
    assert.deepEqual(edit.range.start, new api.Position(0, 0)); assert.deepEqual(edit.range.end, new api.Position(1, 6));
    codes(await f.service.update(input, token), 'stale_snapshot');
  } finally { f.cleanup(); }
});

for (const change of ['text', 'version', 'language', 'undo'] as const) test(`reject ${change} changes since read, with no editor submission`, async () => {
  const f = setup();
  try {
    const input = f.snapshot(); const doc = f.documents[1]!;
    if (change === 'text') doc.text = 'changed even with same mocked version';
    if (change === 'version') doc.version++;
    if (change === 'language') doc.languageId = 'r';
    if (change === 'undo') { doc.text = 'old AI target'; doc.version += 2; }
    codes(await f.service.update(input, token), 'conflict'); assert.equal(f.edits.length, 0);
    codes(await f.service.update(input, token), 'stale_snapshot');
  } finally { f.cleanup(); }
});

test('moving a cell and switching active notebooks never retargets the edit by index or focus', async () => {
  const f = setup();
  try {
    const input = f.snapshot(); const target = f.cells[1]!;
    f.cells.splice(1, 1); f.cells.unshift(target);
    const other = fixture(['other notebook'], 'file:///work/other.ipynb');
    api.workspace.notebookDocuments.push(other.notebook);
    api.window.activeNotebookEditor = { notebook: other.notebook, selection: new api.NotebookRange(0, 1) } as unknown as vscode.NotebookEditor;
    assert.equal((await f.service.update(input, token)).ok, true);
    assert.equal(f.cells[0], target); assert.equal(f.documents[1]!.text, input.newText);
    assert.equal(other.documents[0]!.text, 'other notebook');
  } finally { f.cleanup(); }
});

test('deleted cell or replacement at the same index/URI cannot use the old identity', async () => {
  const f = setup();
  try {
    const input = f.snapshot(); f.cells.splice(1, 1);
    codes(await f.service.update(input, token), 'target_missing');
    const replacement = fixture(['replacement']);
    f.cells.splice(1, 0, { ...replacement.cells[0]!, notebook: f.notebook, document: {
      ...replacement.cells[0]!.document, uri: uri('vscode-notebook-cell:file:///work/demo.ipynb#1')
    } } as vscode.NotebookCell);
    codes(await f.service.update(input, token), 'target_missing'); assert.equal(f.edits.length, 0);
  } finally { f.cleanup(); }
});

test('closing/reopening the same notebook path invalidates all old snapshots and cell identities', async () => {
  const f = setup();
  try {
    const input = f.snapshot(); f.state.closed = true;
    api.notebookClosed.fire(f.notebook);
    const reopened = fixture(); api.workspace.notebookDocuments = [reopened.notebook];
    codes(await f.service.update(input, token), 'target_missing');
    const listing = f.service.list({ notebookUri: input.notebookUri }, token).cells as { cellId: string }[];
    assert.notEqual(listing[1]!.cellId, input.cellId);
    codes(await f.service.update({ ...input, cellId: listing[1]!.cellId }, token), 'stale_snapshot');
    assert.equal(f.edits.length, 0);
  } finally { f.cleanup(); }
});

test('snapshots cannot cross cells, notebooks, or service sessions', async () => {
  const f = setup(); const otherService = new NotebookLiveEdit();
  try {
    const input = f.snapshot();
    codes(await f.service.update({ ...input, cellId: f.input(0).cellId }, token), 'stale_snapshot');
    const other = fixture(['other'], 'file:///work/other.ipynb'); api.workspace.notebookDocuments.push(other.notebook);
    codes(await f.service.update({ ...input, notebookUri: other.notebook.uri.toString() }, token), 'target_missing');
    otherService.list({ notebookUri: input.notebookUri }, token);
    codes(await otherService.update(input, token), 'target_missing'); assert.equal(f.edits.length, 0);
  } finally { otherService.dispose(); f.cleanup(); }
});

test('cell locks are visible, prevent own AI edits, and invalidate pre-lock snapshots even after unlock', async () => {
  const f = setup(); let changes = 0; const listener = f.service.onDidChangeCellStatusBarItems(() => changes++);
  try {
    const input = f.snapshot(); f.service.toggleLock(f.cells[1]!);
    assert.equal(f.service.read(f.input(), token).locked, true);
    assert.match(f.service.provideCellStatusBarItems(f.cells[1]!)[0]!.text, /AI locked/);
    codes(await f.service.update(input, token), 'cell_locked');
    const lockedRead = f.snapshot(); f.service.toggleLock(f.cells[1]!);
    assert.equal(changes, 2); assert.match(f.service.provideCellStatusBarItems(f.cells[1]!)[0]!.text, /AI editable/);
    codes(await f.service.update(lockedRead, token), 'stale_snapshot');
    codes(await f.service.update(input, token), 'stale_snapshot');
    assert.equal((await f.service.update(f.snapshot(), token)).ok, true);
  } finally { listener.dispose(); f.cleanup(); }
});

test('command-palette lock targets the selected cell; a stale explicit cell never falls back to another target', () => {
  const f = setup();
  try {
    api.window.activeNotebookEditor = { notebook: f.notebook, selection: new api.NotebookRange(1, 2) } as unknown as vscode.NotebookEditor;
    f.service.toggleLock(); assert.equal(f.service.read(f.input(), token).locked, true);
    const stale = f.cells.shift()!;
    f.service.toggleLock(stale); assert.equal(f.service.read(f.input(), token).locked, true);
  } finally { f.cleanup(); }
});

test('concurrent same-cell update is rejected, and a lock cannot pretend to revoke an already submitted edit', async () => {
  const f = setup(); const gate = deferred<boolean>();
  try {
    const input = f.snapshot(); const actualApply = api.workspace.applyEdit;
    let submitted: api.WorkspaceEdit | undefined;
    api.workspace.applyEdit = async edit => { submitted = edit; await gate.promise; return actualApply(edit); };
    const pending = f.service.update(input, token);
    assert.ok(submitted); codes(await f.service.update(input, token), 'edit_pending');
    f.service.toggleLock(f.cells[1]!); assert.equal(f.service.read(f.input(), token).locked, false);
    gate.resolve(true); assert.equal((await pending).ok, true);
    f.service.toggleLock(f.cells[1]!); assert.equal(f.service.read(f.input(), token).locked, true);
  } finally { gate.resolve(true); f.cleanup(); }
});

test('different-cell edits can be pending independently', async () => {
  const f = setup(); const gate = deferred<boolean>();
  try {
    const one = f.snapshot(0); const two = f.snapshot(1); const apply = api.workspace.applyEdit;
    let submissions = 0;
    api.workspace.applyEdit = async edit => { submissions++; await gate.promise; return apply(edit); };
    const first = f.service.update(one, token); const second = f.service.update(two, token);
    assert.equal(submissions, 2); gate.resolve(true);
    assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  } finally { gate.resolve(true); f.cleanup(); }
});

for (const mode of ['false', 'throw'] as const) test(`applyEdit ${mode} is sanitized and consumes every snapshot for the target`, async () => {
  const f = setup();
  try {
    const input = f.snapshot(); const another = f.snapshot();
    api.workspace.applyEdit = async () => { if (mode === 'throw') throw new Error('PRIVATE SOURCE AND TOKEN'); return false; };
    const result = await f.service.update(input, token);
    codes(result, mode === 'throw' ? 'edit_failed' : 'edit_rejected'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    codes(await f.service.update(another, token), 'stale_snapshot'); assert.equal(f.documents[1]!.text, 'old AI target');
  } finally { f.cleanup(); }
});

test('cancellation before invocation submits nothing; cancellation after submission reports the actual applied edit', async () => {
  const f = setup(); const gate = deferred<boolean>();
  try {
    const input = f.snapshot();
    assert.throws(() => f.service.list({}, cancelled), /Cancelled/);
    assert.throws(() => f.service.read(f.input(), cancelled), /Cancelled/);
    await assert.rejects(f.service.update(input, cancelled), /Cancelled/); assert.equal(f.edits.length, 0);
    const liveToken = { ...token, isCancellationRequested: false }; const apply = api.workspace.applyEdit;
    api.workspace.applyEdit = async edit => { await gate.promise; return apply(edit); };
    const pending = f.service.update(input, liveToken); liveToken.isCancellationRequested = true; gate.resolve(true);
    assert.equal((await pending).applied, true); assert.equal(f.documents[1]!.text, input.newText);
  } finally { gate.resolve(true); f.cleanup(); }
});

test('expired and evicted snapshots are rejected', async () => {
  let now = 100; const f = setup(undefined, () => now);
  try {
    const expired = f.snapshot(); now += 15 * 60 * 1000;
    codes(await f.service.update(expired, token), 'stale_snapshot');
    const oldest = f.snapshot(); for (let i = 0; i < 256; i++) f.snapshot();
    codes(await f.service.update(oldest, token), 'stale_snapshot'); assert.equal(f.edits.length, 0);
  } finally { f.cleanup(); }
});

test('invalid, oversized UTF-8, and unavailable targets fail closed; an empty replacement is valid', async () => {
  const f = setup();
  try {
    codes(f.service.list({ offset: -1 }, token), 'invalid_input');
    codes(f.service.list({ offset: Number.MAX_SAFE_INTEGER }, token), 'invalid_input');
    codes(f.service.list({ notebookUri: 'file:///unopened.ipynb' }, token), 'not_open');
    codes(f.service.read({ notebookUri: '', cellId: '' }, token), 'target_missing');
    const input = f.snapshot();
    codes(await f.service.update({ ...input, snapshotId: '' }, token), 'invalid_input');
    codes(await f.service.update({ ...input, newText: '界'.repeat(90000) }, token), 'source_too_large');
    assert.equal((await f.service.update({ ...input, newText: '' }, token)).ok, true); assert.equal(f.documents[1]!.text, '');
  } finally { f.cleanup(); }
});

test('identical source is a one-shot no-op without applyEdit', async () => {
  const f = setup();
  try {
    const input = { ...f.snapshot(), newText: 'old AI target' };
    assert.equal((await f.service.update(input, token)).unchanged, true); assert.equal(f.edits.length, 0);
    codes(await f.service.update(input, token), 'stale_snapshot');
  } finally { f.cleanup(); }
});

test('lock command safely ignores an empty notebook or absent editor', () => {
  const f = setup([]);
  try {
    assert.doesNotThrow(() => f.service.toggleLock());
    api.window.activeNotebookEditor = { notebook: f.notebook, selection: new api.NotebookRange(0, 0) } as unknown as vscode.NotebookEditor;
    assert.doesNotThrow(() => f.service.toggleLock());
  } finally { f.cleanup(); }
});

test('notebook and cell listings are paginated; unsupported notebook types are excluded', () => {
  const f = setup(Array.from({ length: 201 }, (_, i) => `cell ${i}`));
  try {
    api.workspace.notebookDocuments.push({ ...f.notebook, notebookType: 'other-type' });
    const page = f.service.list({ notebookUri: f.notebook.uri.toString() }, token);
    assert.equal((page.cells as unknown[]).length, 100); assert.equal(page.nextOffset, 100);
    const tail = f.service.list({ notebookUri: f.notebook.uri.toString(), offset: 200 }, token);
    assert.equal((tail.cells as unknown[]).length, 1); assert.equal(tail.nextOffset, null);
    assert.equal((f.service.list({}, token).notebooks as unknown[]).length, 1);
    for (let i = 0; i < 101; i++) api.workspace.notebookDocuments.push(fixture([], `untitled:notebook-${i}`).notebook);
    assert.equal((f.service.list({}, token).notebooks as unknown[]).length, 100);
    assert.equal((f.service.list({ offset: 100 }, token).notebooks as unknown[]).length, 2);
  } finally { f.cleanup(); }
});

test('untrusted workspaces and disposed tools never read or apply cell edits', async () => {
  const f = setup();
  try {
    const input = f.snapshot(); api.workspace.isTrusted = false;
    codes(f.service.list({}, token), 'untrusted_workspace'); codes(f.service.read(f.input(), token), 'untrusted_workspace');
    codes(await f.service.update(input, token), 'untrusted_workspace'); assert.deepEqual(f.service.provideCellStatusBarItems(f.cells[1]!), []);
    api.workspace.isTrusted = true; f.service.dispose();
    codes(f.service.list({}, token), 'unavailable'); codes(await f.service.update(input, token), 'unavailable'); assert.equal(f.edits.length, 0);
  } finally { f.cleanup(); }
});

test('registered tools match the manifest, require post-approval snapshot checks, and dispose completely', async () => {
  const f = setup(); const subscriptions: vscode.Disposable[] = [];
  try {
    registerNotebookTools({ subscriptions } as vscode.ExtensionContext);
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    assert.deepEqual([...api.registeredTools.keys()].sort(), manifest.contributes.languageModelTools.map((tool: { name: string }) => tool.name).sort());
    for (const entry of manifest.contributes.languageModelTools) {
      assert.equal(entry.canBeReferencedInPrompt, true); assert.equal(entry.when, 'isWorkspaceTrusted');
      assert.equal(entry.inputSchema.additionalProperties, false);
    }
    const invoke = async (name: string, input: object) => {
      const result = await api.registeredTools.get(name)!.invoke({ input } as vscode.LanguageModelToolInvocationOptions<unknown>, token);
      return JSON.parse((result!.content[0] as api.LanguageModelTextPart).value);
    };
    const list = await invoke(NOTEBOOK_TOOLS.list, { notebookUri: f.notebook.uri.toString() });
    const input = { notebookUri: f.notebook.uri.toString(), cellId: list.cells[1].cellId };
    const read = await invoke(NOTEBOOK_TOOLS.read, input);
    const update = { ...input, snapshotId: read.snapshotId, newText: 'tool path source' };
    const updateTool = api.registeredTools.get(NOTEBOOK_TOOLS.update)!;
    const confirmation = await updateTool.prepareInvocation!({ input: update }, token);
    assert.ok(confirmation!.confirmationMessages); assert.equal(f.edits.length, 0, 'preparation must have no edit side effects');
    f.documents[1]!.text = 'typed during approval'; f.documents[1]!.version++;
    codes(await invoke(NOTEBOOK_TOOLS.update, update), 'conflict'); assert.equal(f.edits.length, 0);
    const fresh = await invoke(NOTEBOOK_TOOLS.read, input);
    assert.equal((await invoke(NOTEBOOK_TOOLS.update, { ...update, snapshotId: fresh.snapshotId })).applied, true);
    assert.equal(f.documents[1]!.text, 'tool path source');
    const provider = api.notebookStatusProviders.get('jupyter-notebook')!;
    const items = await provider.provideCellStatusBarItems(f.cells[1]!, token);
    assert.ok(Array.isArray(items)); assert.equal((items[0]!.command as vscode.Command).command, NOTEBOOK_LOCK_COMMAND);
    api.registeredCommands.get(NOTEBOOK_LOCK_COMMAND)!(f.cells[1]!);
    assert.equal((await invoke(NOTEBOOK_TOOLS.read, input)).locked, true);
  } finally { for (const item of subscriptions) item.dispose(); f.cleanup(); }
  assert.equal(api.registeredTools.size, 0); assert.equal(api.notebookStatusProviders.size, 0); assert.equal(api.registeredCommands.size, 0);
});

test('production CJS bundle exposes working live-cell tools without credentials, network, saving or model invocation', async () => {
  const f = setup(); const subscriptions: vscode.Disposable[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-notebook-bundle-'));
  const filename = resolve('.test-build/extension-under-test.cjs'); const load = createRequire(filename);
  const module = { exports: {} as { activate(context: vscode.ExtensionContext): void } };
  let requests = 0; let secretWrites = 0;
  try {
    runInNewContext(await readFile(filename, 'utf8'), {
      module, exports: module.exports, require: (id: string) => id === 'vscode' ? api : load(id),
      process, global: globalThis, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
      setImmediate, clearImmediate, queueMicrotask, AbortController, AbortSignal, URL, URLSearchParams,
      TextDecoder, TextEncoder, crypto: globalThis.crypto,
      fetch: async () => { requests++; throw new Error('Network forbidden'); }
    }, { filename, timeout: 5000 });
    module.exports.activate({
      subscriptions, globalStorageUri: { scheme: 'file', authority: '', fsPath: directory },
      secrets: { get: async () => undefined, store: async () => { secretWrites++; }, onDidChange: () => ({ dispose() {} }) },
      globalState: { get: () => undefined, update: async () => undefined }
    } as unknown as vscode.ExtensionContext);
    const invoke = async (name: string, input: object) => {
      const result = await api.registeredTools.get(name)!.invoke({ input } as vscode.LanguageModelToolInvocationOptions<unknown>, token);
      return JSON.parse((result!.content[0] as api.LanguageModelTextPart).value);
    };
    const uri = f.notebook.uri.toString();
    const list = await invoke(NOTEBOOK_TOOLS.list, { notebookUri: uri });
    const input = { notebookUri: uri, cellId: list.cells[1].cellId };
    const read = await invoke(NOTEBOOK_TOOLS.read, input); assert.equal(read.source, 'old AI target');
    assert.equal((await invoke(NOTEBOOK_TOOLS.update, { ...input, snapshotId: read.snapshotId, newText: 'bundle live source' })).applied, true);
    assert.equal(f.documents[1]!.text, 'bundle live source'); assert.equal(f.documents[0]!.text, 'unsaved user input');
    assert.equal(f.state.saves, 0); assert.equal(requests, 0); assert.equal(secretWrites, 0); assert.equal(api.browserOpens, 0);
  } finally {
    for (const item of subscriptions) item.dispose(); f.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(api.registeredTools.size, 0); assert.equal(api.notebookStatusProviders.size, 0);
  assert.equal(api.registeredCommands.size, 0); assert.equal(api.registeredProviders.size, 0);
});
