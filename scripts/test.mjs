import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
await mkdir('.test-build', { recursive: true });
// Exercise the same bundled CJS entry point that will ship, not only source imports.
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node22',
  format: 'cjs', outfile: '.test-build/extension-under-test.cjs', external: ['vscode'],
  sourcemap: false, legalComments: 'inline', logLevel: 'warning' });
const files = (await readdir('test')).filter(name => name.endsWith('.test.ts'));
await build({ entryPoints: files.map(name => `test/${name}`), bundle: true, platform: 'node',
  target: 'node22', format: 'cjs', alias: { vscode: resolve('test/vscode.mock.ts') }, outdir: '.test-build', outExtension: { '.js': '.cjs' }, logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', '--test-timeout=20000', ...files.map(name => `.test-build/${name.replace(/\.ts$/, '.cjs')}`)],
  { stdio: 'inherit', timeout: 60000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
