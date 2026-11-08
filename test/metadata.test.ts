import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

interface Manifest {
  publisher: string; name: string; icon: string; displayName: string; description: string;
  repository: { type: string; url: string }; homepage: string; bugs: { url: string };
  contributes: unknown;
}
async function manifest(): Promise<Manifest> { return JSON.parse(await readFile('package.json', 'utf8')) as Manifest; }

test('store identity and source/support URLs match the user-approved publisher and repository', async () => {
  const item = await manifest();
  assert.equal(`${item.publisher}.${item.name}`, 'lab530.chatgpt-subscription-for-copilot');
  assert.deepEqual(item.repository, { type: 'git', url: 'https://github.com/0x3st/chatgpt-subscription-for-copilot.git' });
  assert.equal(item.homepage, 'https://github.com/0x3st/chatgpt-subscription-for-copilot#readme');
  assert.equal(item.bugs.url, 'https://github.com/0x3st/chatgpt-subscription-for-copilot/issues');
});
test('the chosen conversation icon is a packaged 256px PNG, not the Lab 530 crest', async () => {
  const item = await manifest(); assert.equal(item.icon, 'assets/brand/icon.png');
  const bytes = await readFile(item.icon);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), 256); assert.equal(bytes.readUInt32BE(20), 256);
  const rules = (await readFile('.vscodeignore', 'utf8')).split(/\r?\n/);
  for (const rule of ['**/*', `!${item.icon}`, '!PRIVACY.md']) assert.ok(rules.includes(rule));
  for (const rule of ['!assets/', '!assets/brand/', '!dist/']) assert.ok(!rules.includes(rule), `${rule} would recursively include unwanted files`);
  assert.ok(!rules.includes('!assets/brand/lab530-logo.png'));
  assert.ok(!rules.includes('!assets/brand/logo.svg'));
});
test('actual VSCE file selection includes only seven explicitly allowlisted source files', () => {
  const output = execFileSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'ls', '--no-dependencies'], { encoding: 'utf8', timeout: 15000 });
  assert.deepEqual(output.trim().split(/\r?\n/).sort(), [
    'LICENSE', 'PRIVACY.md', 'README.md', 'THIRD_PARTY_NOTICES.md', 'assets/brand/icon.png', 'dist/extension.cjs', 'package.json'
  ].sort());
});
test('default extension strings, callback language and primary public documentation are English', async () => {
  async function inspect(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await inspect(path);
      else if (path.endsWith('.ts')) assert.doesNotMatch(await readFile(path, 'utf8'), /\p{Script=Han}/u, `${path} contains a non-English default string`);
    }
  }
  await inspect('src');
  const item = await manifest(); assert.doesNotMatch(JSON.stringify([item.displayName, item.description, item.contributes]), /\p{Script=Han}/u);
  assert.match(await readFile('src/auth/callback.ts', 'utf8'), /<html lang="en">/);
  const readme = await readFile('README.md', 'utf8');
  assert.match(readme, /^# ChatGPT Subscription for Copilot/);
  assert.doesNotMatch(readme, /\p{Script=Han}/u);
  const privacy = await readFile('PRIVACY.md', 'utf8');
  assert.match(privacy, /^# Privacy Notice/); assert.doesNotMatch(privacy, /\p{Script=Han}/u);
});
