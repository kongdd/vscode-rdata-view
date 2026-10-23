import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await mkdir('release', { recursive: true });
await build({
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true, platform: 'node', target: 'node18', external: ['vscode'], minify: true,
});
await copyFile('src/extension/scripts/read-table.R', 'dist/read-table.R');
