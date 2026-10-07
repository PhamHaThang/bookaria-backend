import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/main.ts', 'src/worker/main.ts'],
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: true,
    sourcemap: true,
});
