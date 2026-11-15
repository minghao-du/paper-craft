import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    include: [
      'packages/*/tests/**/*.test.ts',
      'scripts/**/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
