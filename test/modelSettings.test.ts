import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { configuration, window } from './vscode.mock';
import { contextWindowError, inputBudget, modelOverride, reasoningEffort, saveModelOverride } from '../src/modelSettings';
import { parseModels, type ChatModel } from '../src/chat/models';
import { ChatGPTProvider } from '../src/provider';
import { AccountManager } from '../src/auth/accounts';
import { HttpClient } from '../src/http';
import { API } from '../src/core';
import { MemoryStore, fake, json, oauth, registration, signal, sse } from './helpers';

const model: ChatModel = { id: 'test-model', name: 'Test', inputTokens: 128000, outputTokens: 4096,
  images: false, tools: true, efforts: ['low', 'high'], estimatedLimits: false };
const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info() {}, warn() {} } as unknown as vscode.LogOutputChannel;
function clear(): void { for (const key of Object.keys(configuration)) delete configuration[key]; }

test('per-model settings ignore workspace data, unknown IDs and inherited properties', () => {
  try {
    configuration.modelOverrides = { defaultValue: {}, workspaceValue: { 'test-model': { reasoningEffort: 'max', contextWindow: 2000000 } } };
    assert.deepEqual(modelOverride(model.id), {});
    configuration.modelOverrides.globalValue = { 'test-model': { reasoningEffort: 'high', contextWindow: 64000 }, unknown: { invalid: true } };
    assert.deepEqual(modelOverride(model.id), { reasoningEffort: 'high', contextWindow: 64000 });
    assert.deepEqual(modelOverride('missing'), {}); assert.deepEqual(modelOverride('toString'), {});
  } finally { clear(); }
});

test('reasoning precedence is request, per-model, global, server; unsupported effort fails closed', () => {
  try {
    configuration.modelOverrides = { globalValue: { 'test-model': { reasoningEffort: 'low' } } };
    assert.equal(reasoningEffort(model, undefined, 'high'), 'low');
    assert.equal(reasoningEffort(model, 'high', 'low'), 'high');
    assert.equal(reasoningEffort(model, 'default', 'high'), undefined);
    assert.throws(() => reasoningEffort(model, 'max', undefined), /not declared support/);
    for (const bad of ['off', '', null, false, {}]) assert.throws(() => reasoningEffort(model, bad, 'high'), /Invalid reasoning effort/);
    configuration.modelOverrides.globalValue = { 'test-model': { reasoningEffort: 'default' } };
    assert.equal(reasoningEffort(model, undefined, 'high'), undefined);
    clear(); assert.equal(reasoningEffort(model, undefined, 'high'), 'high');
    assert.equal(reasoningEffort(model, undefined, undefined), undefined);
  } finally { clear(); }
});

test('context metadata overrides respect declared input caps even when output metadata is estimated', () => {
  const [known] = parseModels({ models: [{ slug: 'known', visibility: 'list', max_input_tokens: 128000 }] });
  assert.ok(known); assert.equal(known.estimatedLimits, true); assert.equal(known.estimatedInputLimit, false);
  assert.equal(inputBudget(known, { contextWindow: 2000000 }), 128000);
  assert.equal(inputBudget(known, { contextWindow: 64000 }), 64000);
  const [unknown] = parseModels({ models: [{ slug: 'unknown', visibility: 'list' }] });
  assert.ok(unknown); assert.equal(unknown.estimatedInputLimit, true);
  assert.equal(inputBudget(unknown, { contextWindow: 1000000 }), 1000000);
  assert.equal(inputBudget(unknown, {}), 32768);
  assert.ok(contextWindowError(known, '128001'));
  assert.equal(contextWindowError(unknown, '1000000'), undefined);
  for (const bad of ['NaN', 'Infinity', '1e6', '-1', '1023', '1000.5', '2000001']) assert.ok(contextWindowError(unknown, bad));
  assert.equal(contextWindowError(known, ''), undefined);
});

test('malformed or endpoint-bearing overrides fail instead of accepting hidden transport options', () => {
  try {
    for (const bad of [[], null, 'bad']) {
      configuration.modelOverrides = { globalValue: bad, defaultValue: {} };
      assert.throws(() => modelOverride(model.id), /Invalid/);
    }
    for (const bad of [[], null, 'bad', { reasoningEffort: 'off' }, { contextWindow: 1 }, { contextWindow: NaN },
      { contextWindow: '128000' }, { baseUrl: 'https://example.invalid' }]) {
      configuration.modelOverrides = { globalValue: { 'test-model': bad } };
      assert.throws(() => modelOverride(model.id), /Invalid/);
    }
  } finally { clear(); }
});

test('saving and resetting one model preserves others and only updates user settings', async () => {
  try {
    configuration.modelOverrides = { globalValue: { other: { reasoningEffort: 'low' } } };
    await saveModelOverride(model.id, { reasoningEffort: 'high' });
    assert.deepEqual(configuration.modelOverrides.globalValue, { other: { reasoningEffort: 'low' }, 'test-model': { reasoningEffort: 'high' } });
    await saveModelOverride(model.id, undefined);
    assert.deepEqual(configuration.modelOverrides.globalValue, { other: { reasoningEffort: 'low' } });
    await saveModelOverride('__proto__', { reasoningEffort: 'high' });
    assert.equal(Object.hasOwn(configuration.modelOverrides.globalValue as object, '__proto__'), true);
    assert.deepEqual(modelOverride('__proto__'), { reasoningEffort: 'high' });
    assert.equal(({} as Record<string, unknown>).reasoningEffort, undefined);
  } finally { clear(); }
});

for (const action of ['Thinking effort', 'Context window', 'Reset model settings'] as const) {
  test(`stable model configuration UI: ${action}`, async () => {
    const accounts = new AccountManager(new MemoryStore([registration()]), oauth()); let inference = 0;
    const http = new HttpClient(fake(url => {
      if (url === `${API}/models`) return json({ models: [{ slug: model.id, display_name: model.name, visibility: 'list',
        max_input_tokens: 128000, supported_reasoning_efforts: ['low', 'high'] }] });
      inference++; throw new Error('Configuring models must not perform inference');
    }));
    const provider = new ChatGPTProvider(accounts, http, async () => false, log);
    const original = { pick: window.showQuickPick, input: window.showInputBox };
    let picks = 0;
    window.showQuickPick = async items => {
      assert.ok(Array.isArray(items)); picks++;
      if (picks === 1) return items[0];
      if (picks === 2) return action;
      assert.deepEqual(items.map(item => item.value), [undefined, 'default', 'low', 'high']);
      return items.find(item => item.value === 'high');
    };
    window.showInputBox = async options => {
      const input = options as { validateInput(value: string): string | undefined };
      assert.ok(input.validateInput('128001')); assert.equal(input.validateInput('64000'), undefined);
      return '64000';
    };
    try {
      configuration.modelOverrides = { globalValue: { 'test-model': { reasoningEffort: 'low', contextWindow: 32000 } } };
      await provider.configureModel(signal());
      const saved = modelOverride(model.id);
      if (action === 'Thinking effort') assert.deepEqual(saved, { reasoningEffort: 'high', contextWindow: 32000 });
      if (action === 'Context window') assert.deepEqual(saved, { reasoningEffort: 'low', contextWindow: 64000 });
      if (action === 'Reset model settings') assert.deepEqual(saved, {});
      assert.equal(inference, 0);
    } finally { provider.dispose(); accounts.dispose(); window.showQuickPick = original.pick; window.showInputBox = original.input; clear(); }
  });
}

for (const scenario of ['dismissed', 'account changed'] as const) {
  test(`model configuration does not persist after the picker is ${scenario}`, async () => {
    const accounts = new AccountManager(new MemoryStore([registration(), registration('oaiapp_B')]), oauth());
    const http = new HttpClient(fake(() => json({ models: [{ slug: model.id, visibility: 'list' }] })));
    const provider = new ChatGPTProvider(accounts, http, async () => false, log);
    const pick = window.showQuickPick;
    window.showQuickPick = async items => {
      if (scenario === 'dismissed') return undefined;
      await accounts.select('oaiapp_B', signal());
      assert.ok(Array.isArray(items)); return items[0];
    };
    try {
      if (scenario === 'dismissed') await provider.configureModel(signal());
      else await assert.rejects(provider.configureModel(signal()), /cancel/i);
      assert.deepEqual(modelOverride(model.id), {});
      assert.equal(configuration.modelOverrides, undefined);
    } finally { provider.dispose(); accounts.dispose(); window.showQuickPick = pick; clear(); }
  });
}

test('provider advertises the configured budget and sends reasoning without unsupported context/output fields', async () => {
  const accounts = new AccountManager(new MemoryStore([registration()]), oauth()); const bodies: Record<string, unknown>[] = [];
  const http = new HttpClient(fake((url, init) => {
    if (url === `${API}/models`) return json({ models: [{ slug: model.id, visibility: 'list', max_input_tokens: 128000, supported_reasoning_efforts: ['low', 'high'] }] });
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
  }));
  const provider = new ChatGPTProvider(accounts, http, async () => false, log);
  try {
    configuration.modelOverrides = { globalValue: { 'test-model': { reasoningEffort: 'high', contextWindow: 64000 } } };
    const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token); assert.ok(info);
    assert.equal(info.maxInputTokens, 64000);
    assert.equal(info.configurationSchema.properties.reasoningEffort!.default, 'high');
    assert.equal(info.configurationSchema.properties.contextSize!.default, 64000);
    await provider.provideLanguageModelChatResponse(info, [{ role: vscode.LanguageModelChatMessageRole.User,
      name: undefined, content: [new vscode.LanguageModelTextPart('Hello')] }], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report() {} }, token);
    assert.deepEqual(bodies[0]!.reasoning, { effort: 'high' });
    for (const field of ['contextWindow', 'max_input_tokens', 'max_output_tokens', 'temperature']) assert.ok(!(field in bodies[0]!));
    configuration.modelOverrides.globalValue = { 'test-model': { reasoningEffort: 'max' } };
    await assert.rejects(provider.provideLanguageModelChatResponse(info, [{ role: vscode.LanguageModelChatMessageRole.User,
      name: undefined, content: [new vscode.LanguageModelTextPart('Hello')] }], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report() {} }, token), /not declared support/);
    assert.equal(bodies.length, 1, 'Unsupported effort must not reach inference');
  } finally { provider.dispose(); accounts.dispose(); clear(); }
});
