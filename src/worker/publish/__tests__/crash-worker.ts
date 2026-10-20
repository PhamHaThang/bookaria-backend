// Spawned only by the integration test against its dedicated test database.
import { readFileSync } from 'node:fs';
import { runJob } from '../../runner';
import { createPublishHandler } from '..';

const jobId = process.argv[2];
if (!jobId || !new URL(process.env.DATABASE_URL ?? '').pathname.endsWith('_test'))
    throw new Error('Test database required');
await runJob(
    jobId,
    createPublishHandler(
        {
            url: ({ publicId }) => `https://example.com/${publicId}`,
            downloadMind: async () =>
                readFileSync(new URL('./fixtures/card.mind', import.meta.url)),
            upload: async () => {
                console.log('UPLOAD_BEFORE_COMMIT');
                return await new Promise<string>(() => {});
            },
        },
        'https://viewer.example.com',
    ),
);
