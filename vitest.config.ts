import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['services/*/test/**/*.unit.test.ts', 'packages/*/test/**/*.unit.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 30000, setupFiles: ['tests/helpers.ts'] } },
      { test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], testTimeout: 60000, setupFiles: ['tests/helpers.ts'], fileParallelism: false } },
    ],
  },
});
