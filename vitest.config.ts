import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The safety suite must never be silently skipped. A pattern that matches
    // nothing is a pass in most runners, which is exactly how a guard rots.
    passWithNoTests: false,
    globalSetup: ['tests/global-setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
