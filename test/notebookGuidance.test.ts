import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { NOTEBOOK_INSTRUCTIONS, prepareRequest } from '../src/chat/request';
import type { ChatModel } from '../src/chat/models';

const model: ChatModel = { id: 'test', name: 'Test', inputTokens: 32000, outputTokens: 4000,
  images: false, tools: true, efforts: [], estimatedLimits: true };

test('manifest and shipped source withdraw the live Notebook tools, AI locks and status-bar registration', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(manifest.version, lock.version); assert.equal(manifest.version, lock.packages[''].version);
  assert.equal(manifest.contributes.languageModelTools, undefined);
  assert.equal(manifest.contributes.commands.length, 7);
  assert.doesNotMatch(JSON.stringify(manifest.contributes), /notebook|cellLock/i);
  assert.doesNotMatch(await readFile('src/extension.ts', 'utf8'), /registerNotebookTools|notebookTools|NotebookCellStatus/);
  await assert.rejects(access('src/notebookTools.ts'), { code: 'ENOENT' });
});

test('outgoing instructions warn about Copilot Notebook tools and request complete cell-level copy/paste replacements', () => {
  const prepared = prepareRequest(model, [{ role: 'user', parts: [{ type: 'text', text: 'Please fix this notebook cell.' }] }], [], false, undefined, false, 'test');
  const instructions = String(prepared.body.instructions);
  assert.ok(instructions.includes(NOTEBOOK_INSTRUCTIONS));
  for (const pattern of [/known issues in Copilot/, /do not use notebook-editing tools/, /\.ipynb.*file-editing tools, terminal commands, or scripts/,
    /cell-level editing suggestions/, /identify each target cell/, /full replacement cell content in a fenced code block with its language/,
    /user can copy and paste/, /ask the user to share them/, /do not invent cells or claim edits, saves, or execution/,
    /\$\.\.\.\$ for inline math/, /Preserve code, tool arguments, and the conversation language/]) assert.match(instructions, pattern);
  assert.equal(prepared.body.tools, undefined);
});

test('Notebook guidance does not rewrite conversation/cell content or silently alter Copilot tool schemas', () => {
  const source = 'print("未保存的 cell: \\(x\\)")';
  const schema = { type: 'object', properties: { text: { type: 'string' } } };
  const prepared = prepareRequest(model, [
    { role: 'user', parts: [{ type: 'text', text: source }] },
    { role: 'assistant', parts: [{ type: 'call', id: 'old-call', name: 'readCell', input: { source } }] },
    { role: 'user', parts: [{ type: 'result', id: 'old-call', content: [{ type: 'text', text: source }] }] }
  ], [{ name: 'readCell', description: 'Read supplied context', schema }], false, undefined, false, 'test');
  const input = prepared.body.input as Record<string, unknown>[];
  assert.deepEqual(input[0]!.content, [{ type: 'input_text', text: source }]);
  assert.equal(input[1]!.arguments, JSON.stringify({ source })); assert.equal(input[2]!.output, source);
  const tools = prepared.body.tools as { tools: { parameters: object }[] }[];
  assert.deepEqual(tools[0]!.tools[0]!.parameters, schema);
});
