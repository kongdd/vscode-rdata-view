import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  build: {
    target: 'es2022',
    rollupOptions: { output: { entryFileNames: 'main.js', assetFileNames: '[name][extname]', inlineDynamicImports: true } },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
