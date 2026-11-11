import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'scripts/**/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
