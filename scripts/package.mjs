import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('artifacts', { recursive: true });
execFileSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies',
  '--out', `artifacts/${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`], { stdio: 'inherit', timeout: 120000 });
