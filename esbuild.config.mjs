import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await mkdir('release', { recursive: true });
await build({
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true, platform: 'node', target: 'node18', external: ['vscode'], minify: true,
});
for (const script of ['read-table.R', 'read-table-server.R', 'table-lib.R']) {
  await copyFile(`src/extension/scripts/${script}`, `dist/${script}`);
}
