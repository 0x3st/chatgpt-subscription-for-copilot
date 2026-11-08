import { build } from 'esbuild';
await build({
  entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node22',
  format: 'cjs', outfile: 'dist/extension.cjs', external: ['vscode'],
  sourcemap: false, legalComments: 'inline', logLevel: 'info'
});
