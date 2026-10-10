import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        env: {
            NODE_ENV: 'test',
            RATE_LIMIT_ENABLED: 'false',
            BCRYPT_ROUNDS: '4',
            COOKIE_SECURE: 'false',
            COOKIE_SAMESITE: 'lax',
        },
        globalSetup: ['./src/test/global-setup.ts'],
        testTimeout: 20_000,
        passWithNoTests: true,
    },
});
