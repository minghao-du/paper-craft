import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['paper-craft-source'] },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
