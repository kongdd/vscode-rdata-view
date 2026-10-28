import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/extension/**/*.test.ts', 'src/shared/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 120_000 } });
