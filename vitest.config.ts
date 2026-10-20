import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Các suite dùng chung database; tránh test cập nhật marker làm đổi snapshot của suite khác.
        fileParallelism: false,
        env: {
            NODE_ENV: 'test',
            RATE_LIMIT_ENABLED: 'false',
            GOOGLE_CLIENT_ID: '',
            BCRYPT_ROUNDS: '4',
            COOKIE_SECURE: 'false',
            COOKIE_SAMESITE: 'lax',
        },
        globalSetup: ['./src/test/global-setup.ts'],
        testTimeout: 20_000,
        passWithNoTests: true,
    },
});
