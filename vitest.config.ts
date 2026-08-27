import { defineConfig } from 'vitest/config';

// One runner for the whole workspace. The library's tests live beside it in
// `packages/neo/test`; the glob already covers `packages/cli/test` for when the
// CLI grows some.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['packages/*/test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            include: ['packages/*/src/**/*.ts'],
        },
    },
});
