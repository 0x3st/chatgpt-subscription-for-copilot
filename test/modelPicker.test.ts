import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { AccountManager } from '../src/auth/accounts';
import { API } from '../src/core';
import { HttpClient } from '../src/http';
import { ChatGPTProvider } from '../src/provider';
import { pickerEffort, pickerOption, refreshNativePicker, type NativeResponseOptions } from '../src/modelPicker';
import { configuration, installedExtensions, nativeModelChanges } from './vscode.mock';
import { MemoryStore, fake, json, oauth, registration, signal, sse } from './helpers';

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
const options = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const message = (text = 'Hello'): vscode.LanguageModelChatRequestMessage => ({ role: vscode.LanguageModelChatMessageRole.User,
  name: undefined, content: [new vscode.LanguageModelTextPart(text)] });
const catalog = { models: [{ slug: 'test-model', display_name: 'Test Model', visibility: 'list', max_input_tokens: 1000000,
  max_output_tokens: 64000, supported_reasoning_efforts: ['low', 'high'] }] };
function fixture(value: unknown = catalog) {
  const accounts = new AccountManager(new MemoryStore([registration()]), oauth());
  const bodies: Record<string, unknown>[] = [];
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) return json(value);
    assert.equal(url, `${API}/responses`); bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  return { provider, bodies, dispose() { provider.dispose(); accounts.dispose(); for (const key of Object.keys(configuration)) delete configuration[key]; } };
}

test('native compatibility metadata does not opt into proposed VS Code APIs', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { enableProposedApi?: boolean; enabledApiProposals?: unknown[] };
  assert.equal(manifest.enableProposedApi ?? false, false);
  assert.deepEqual(manifest.enabledApiProposals ?? [], []);
});

test('one model exposes native thinking and context submenus, not synthetic detail labels or model variants', async () => {
  const f = fixture();
  try {
    configuration.reasoningEffort = { globalValue: 'high' };
    const models = await f.provider.provideLanguageModelChatInformation({ silent: true }, token);
    assert.equal(models.length, 1);
    const info = models[0]!; const properties = info.configurationSchema.properties;
    const thinking = properties.reasoningEffort!; const context = properties.contextSize!;
    assert.equal(thinking.group, 'navigation'); assert.equal(thinking.default, 'high');
    assert.deepEqual(thinking.enum, ['inherit', 'default', 'low', 'high']);
    assert.equal(thinking.enumItemLabels[thinking.enum.indexOf('high')], 'High');
    assert.equal(context.group, 'tokens'); assert.equal(context.type, 'number'); assert.equal(context.default, 1000000);
    assert.equal(context.enumItemLabels[context.enum.indexOf(1000000)], 'Max 1M');
    assert.ok(context.enum.includes(64000)); assert.ok(context.enum.every(value => typeof value === 'number' && value <= info.maxInputTokens));
    assert.doesNotMatch(info.detail!, /thinking|context|High|Max 1M/);
    assert.equal(f.bodies.length, 0);
  } finally { f.dispose(); }
});

for (const carrier of ['modelOptions', 'modelConfiguration', 'configuration'] as const) {
  test(`native ${carrier} choices reach Responses as effort and a local budget, not unsupported API fields`, async () => {
    const f = fixture();
    try {
      const [info] = await f.provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
      await f.provider.provideLanguageModelChatResponse(info, [message()], { ...options,
        [carrier]: { reasoningEffort: 'high', contextSize: 64000 } }, { report() {} }, token);
      assert.deepEqual(f.bodies[0]!.reasoning, { effort: 'high' });
      for (const key of ['contextSize', 'contextWindow', 'configuration', 'modelConfiguration', 'configurationSchema', 'max_input_tokens', 'max_output_tokens']) {
        assert.ok(!(key in f.bodies[0]!), `Never forward ${key}`);
      }
      assert.equal(configuration.modelOverrides, undefined, 'Native choices must not overwrite extension defaults');
    } finally { f.dispose(); }
  });
}

test('option precedence is field-by-field and invalid explicit selections do not fall through', () => {
  const value: NativeResponseOptions = { ...options, modelOptions: { reasoningEffort: 'low' }, modelConfiguration: { reasoningEffort: 'high', contextSize: 64000 },
    configuration: { reasoningEffort: 'default', contextSize: 32000 } };
  assert.equal(pickerEffort(value), 'low'); assert.equal(pickerOption(value, 'contextSize'), 64000);
  assert.equal(pickerEffort({ ...options, modelConfiguration: { reasoningEffort: 'inherit' } }), undefined);
  assert.equal(pickerEffort({ ...options, modelOptions: { reasoningEffort: null }, modelConfiguration: { reasoningEffort: 'high' } }), null);
  const inherited = Object.create({ reasoningEffort: 'high' }) as Record<string, unknown>;
  assert.equal(pickerEffort({ ...options, modelOptions: inherited }), undefined);
});

test('native default and saved-setting choices preserve server-default and existing preference semantics', async () => {
  const f = fixture();
  try {
    configuration.modelOverrides = { globalValue: { 'test-model': { reasoningEffort: 'high' } } };
    const [info] = await f.provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    await f.provider.provideLanguageModelChatResponse(info, [message()], { ...options, modelConfiguration: { reasoningEffort: 'default' } }, { report() {} }, token);
    assert.ok(!('reasoning' in f.bodies[0]!));
    await f.provider.provideLanguageModelChatResponse(info, [message()], { ...options, modelConfiguration: { reasoningEffort: 'inherit' } }, { report() {} }, token);
    assert.deepEqual(f.bodies[1]!.reasoning, { effort: 'high' });
  } finally { f.dispose(); }
});

test('unsupported native effort and malformed, excessive or stale context budgets fail before inference', async () => {
  const f = fixture();
  try {
    const [info] = await f.provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    for (const value of ['max', 'off', null, false, '']) {
      await assert.rejects(f.provider.provideLanguageModelChatResponse(info, [message()], {
        ...options, modelConfiguration: { reasoningEffort: value }
      }, { report() {} }, token), /reasoning effort/);
    }
    for (const value of [null, '64000', 0, 1023, 64000.5, NaN, Infinity, 1000001]) {
      await assert.rejects(f.provider.provideLanguageModelChatResponse(info, [message()], {
        ...options, modelConfiguration: { contextSize: value }
      }, { report() {} }, token), /context budget/);
    }
    configuration.modelOverrides = { globalValue: { 'test-model': { contextWindow: 32000 } } };
    await assert.rejects(f.provider.provideLanguageModelChatResponse(info, [message()], {
      ...options, modelConfiguration: { contextSize: 64000 }
    }, { report() {} }, token), /context budget/);
    assert.equal(f.bodies.length, 0);
  } finally { f.dispose(); }
});

test('a context selection from another account cannot exceed the current account catalog for the same model ID', async () => {
  const accounts = new AccountManager(new MemoryStore([registration(), registration('oaiapp_B')]), oauth()); let inference = 0;
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) {
      const auth = new Headers(init.headers).get('Authorization') ?? '';
      return json({ models: [{ slug: 'same-model', visibility: 'list', max_input_tokens: auth.includes('oaiapp_B') ? 128000 : 1000000 }] });
    }
    inference++; throw new Error('A stale account budget must not reach inference');
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    await accounts.select('oaiapp_B', signal());
    await assert.rejects(provider.provideLanguageModelChatResponse(info, [message()], {
      ...options, modelConfiguration: { contextSize: 1000000 }
    }, { report() {} }, token), /context budget/);
    assert.equal(inference, 0);
  } finally { provider.dispose(); accounts.dispose(); }
});

test('selected context budget rejects excess history or tool definitions instead of truncating or silently ignoring it', async () => {
  const f = fixture(); const text = 'x'.repeat(10000);
  try {
    const [info] = await f.provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    await assert.rejects(f.provider.provideLanguageModelChatResponse(info, [message(text)], {
      ...options, modelConfiguration: { contextSize: 1024 }
    }, { report() {} }, token), /No history was dropped/);
    await assert.rejects(f.provider.provideLanguageModelChatResponse(info, [message()], {
      ...options, modelConfiguration: { contextSize: 1024 }, tools: [{ name: 'tool', description: text, inputSchema: {} }]
    }, { report() {} }, token), /selected input context budget/);
    assert.equal(f.bodies.length, 0);
    await f.provider.provideLanguageModelChatResponse(info, [message(text)], { ...options, modelConfiguration: { contextSize: 16000 } }, { report() {} }, token);
    assert.equal(JSON.stringify(f.bodies[0]!.input).includes(text), true);
  } finally { f.dispose(); }
});

test('missing input metadata never produces a guessed 1M menu ceiling; explicit saved overrides are honored', async () => {
  const f = fixture({ models: [{ slug: 'test-model', visibility: 'list' }] });
  try {
    const [info] = await f.provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    assert.equal(info.maxInputTokens, 32768);
    assert.ok(!info.configurationSchema.properties.contextSize!.enum.includes(1000000));
    configuration.modelOverrides = { globalValue: { 'test-model': { contextWindow: 1000000 } } };
    const [updated] = await f.provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(updated);
    assert.equal(updated.configurationSchema.properties.contextSize!.default, 1000000);
  } finally { f.dispose(); }
});

test('unsupported saved efforts are not silently substituted by a schema default', async () => {
  const f = fixture();
  try {
    configuration.reasoningEffort = { globalValue: 'max' };
    const [info] = await f.provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    assert.equal(info.configurationSchema.properties.reasoningEffort!.default, 'inherit');
    await assert.rejects(f.provider.provideLanguageModelChatResponse(info, [message()], {
      ...options, modelConfiguration: { reasoningEffort: 'inherit' }
    }, { report() {} }, token), /not declared support/);
    assert.equal(f.bodies.length, 0);
  } finally { f.dispose(); }
});

test('passive post-activation refresh happens once without activating Copilot or creating a feedback loop', async () => {
  const extension = { isActive: false }; installedExtensions.set('github.copilot-chat', extension);
  let count = 0;
  const subscription = refreshNativePicker(() => { count++; nativeModelChanges.fire(); }, signal());
  try {
    await Promise.resolve(); nativeModelChanges.fire(); assert.equal(count, 0);
    extension.isActive = true; nativeModelChanges.fire(); assert.equal(count, 1);
    nativeModelChanges.fire(); assert.equal(count, 1);
  } finally { subscription.dispose(); installedExtensions.clear(); }
});

test('registration before Copilot marks activation complete is handled by one deferred event check', async () => {
  const extension = { isActive: false }; installedExtensions.set('github.copilot-chat', extension); let count = 0;
  const subscription = refreshNativePicker(() => { count++; }, signal());
  try {
    nativeModelChanges.fire();
    await Promise.resolve(); extension.isActive = true;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(count, 1);
    nativeModelChanges.fire(); assert.equal(count, 1);
  } finally { subscription.dispose(); installedExtensions.clear(); }
});

test('disposed or canceled passive refresh ignores late activation and queued checks', async () => {
  installedExtensions.set('github.copilot-chat', { isActive: true }); let count = 0;
  const cancelled = new AbortController(); cancelled.abort();
  const one = refreshNativePicker(() => { count++; }, cancelled.signal);
  const two = refreshNativePicker(() => { count++; }, signal()); two.dispose();
  try { await Promise.resolve(); nativeModelChanges.fire(); assert.equal(count, 0); }
  finally { one.dispose(); two.dispose(); installedExtensions.clear(); }
});
