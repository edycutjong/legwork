import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/ts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000, // the fast-check properties run 20,000 cases; under coverage instrumentation that takes ~20 s
    coverage: { provider: 'v8', include: ['src/lib/**'], reporter: ['text', 'lcov'] },
  },
});
