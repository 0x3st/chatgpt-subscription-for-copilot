import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';

interface Step { name: string; id?: string; uses?: string; run?: string; with?: Record<string, unknown> }
interface Job { needs?: string; 'timeout-minutes': number; permissions: Record<string, string>; environment?: { name: string }; steps: Step[] }
interface Workflow { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: { 'cancel-in-progress': boolean }; jobs: Record<string, Job> }
const text = readFileSync('.github/workflows/publish2marketplace.yml', 'utf8');
const document = parseDocument(text); assert.deepEqual(document.errors, []);
const workflow = document.toJS() as Workflow;
function script(step: Step | undefined): string {
  assert.ok(step?.run);
  const code = /^node <<'NODE'\n([\s\S]*)\nNODE\s*$/.exec(step.run);
  assert.ok(code, 'Execute the exact inline Node script from the workflow');
  return code[1]!;
}

test('publishing is manual, bounded, commit-pinned and least-privileged', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(workflow.jobs), ['verify', 'publish']);
  assert.deepEqual(workflow.jobs.verify!.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish!.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(workflow.jobs.publish!.needs, 'verify');
  assert.equal(workflow.jobs.publish!.environment?.name, 'marketplace');
  const allowed = new Set(['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact']);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
    for (const step of job.steps) {
      if (step.uses) {
        assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/); assert.ok(allowed.has(step.uses.split('@')[0]!));
        if (step.uses.startsWith('actions/checkout@')) {
          assert.equal(step.with?.ref, '${{ github.sha }}'); assert.equal(step.with?.['persist-credentials'], false);
        }
      }
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*(inputs|github\.event)/, 'Never interpolate input directly into a shell script');
    }
  }
  assert.doesNotMatch(text, /secrets\.|VSCE_PAT|--pat\b|--skip-duplicate|--no-verify|git push|git tag/);
  assert.match(text, /api-version=7\.2-preview\.1/);
  const steps = workflow.jobs.verify!.steps;
  assert.ok(steps.findIndex(step => step.id === 'guard') < steps.findIndex(step => step.run?.startsWith('npm ci')));
  for (const command of ['npm run check', 'npm test', 'npm audit --audit-level=low', 'npm run package']) assert.ok(steps.some(step => step.run === command));
  const publishSteps = workflow.jobs.publish!.steps;
  assert.match(publishSteps.at(-1)!.run!, /^npx --no-install vsce publish --packagePath "\$PACKAGE_PATH" --oidc$/);
  assert.ok(publishSteps.at(-2)!.run?.includes('createHash'));
});

test('the actual release guard rejects unapproved, stale, foreign, malformed and wrong-version dispatches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-release-guard-'));
  const guard = script(workflow.jobs.verify!.steps.find(step => step.id === 'guard'));
  const commit = 'a'.repeat(40); const output = join(directory, 'output');
  const manifest = { version: '0.1.0', publisher: 'lab530', name: 'chatgpt-subscription-for-copilot', repository: { url: 'https://github.com/0x3st/chatgpt-subscription-for-copilot.git' } };
  const base = { ...process.env, GITHUB_REPOSITORY: '0x3st/chatgpt-subscription-for-copilot', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: commit, EXPECTED_COMMIT: commit, EXPECTED_VERSION: '0.1.0', CONFIRM_PUBLISH: 'true', GITHUB_OUTPUT: output };
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    execFileSync(process.execPath, ['-e', guard], { cwd: directory, env: base, timeout: 10000, stdio: 'pipe' });
    assert.equal(await readFile(output, 'utf8'), 'package_name=lab530.chatgpt-subscription-for-copilot-0.1.0.vsix\n');
    for (const patch of [
      { CONFIRM_PUBLISH: 'false' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_REPOSITORY: 'someone/fork' },
      { GITHUB_REPOSITORY: '0x3st/chatgpt-for-copilot' },
      { EXPECTED_COMMIT: 'b'.repeat(40) }, { EXPECTED_COMMIT: 'short-sha' }, { EXPECTED_VERSION: '0.2.0' },
      { EXPECTED_VERSION: '0.1.0-beta' }, { EXPECTED_VERSION: '0.1.0; echo injection' }, { EXPECTED_VERSION: '00.1.0' }
    ]) assert.throws(() => execFileSync(process.execPath, ['-e', guard], { cwd: directory, env: { ...base, ...patch }, timeout: 10000, stdio: 'pipe' }));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, name: 'chatgpt-for-copilot' }));
    assert.throws(() => execFileSync(process.execPath, ['-e', guard], { cwd: directory, env: base, timeout: 10000, stdio: 'pipe' }));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, publisher: 'local-dev' }));
    assert.throws(() => execFileSync(process.execPath, ['-e', guard], { cwd: directory, env: base, timeout: 10000, stdio: 'pipe' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the actual pre-publication hash check refuses modified or unverified artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-release-hash-'));
  const verify = script(workflow.jobs.publish!.steps.at(-2));
  const path = join(directory, 'package.vsix'); const bytes = Buffer.from('synthetic package bytes');
  const env = { ...process.env, PACKAGE_PATH: path, EXPECTED_SHA256: createHash('sha256').update(bytes).digest('hex') };
  try {
    await writeFile(path, bytes);
    execFileSync(process.execPath, ['-e', verify], { cwd: directory, env, timeout: 10000, stdio: 'pipe' });
    await writeFile(path, 'modified');
    assert.throws(() => execFileSync(process.execPath, ['-e', verify], { cwd: directory, env, timeout: 10000, stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, ['-e', verify], { cwd: directory, env: { ...env, EXPECTED_SHA256: '' }, timeout: 10000, stdio: 'pipe' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
