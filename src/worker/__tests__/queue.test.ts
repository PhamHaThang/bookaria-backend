import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { pool } from '../../db';
import { startQueueWorker } from '../queue';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });

suite('queue worker', () => {
    it('chạy job có handler, giữ job chưa có handler và đóng pg-boss khi dừng', async () => {
        const registered = await request(app)
            .post('/api/v1/auth/register')
            .send({
                email: `queue-${randomUUID()}@example.com`,
                displayName: 'Tác giả',
                password: 'Matkhau-123',
            });
        expect(registered.status).toBe(201);
        const userId = registered.body.data.user.id as string;
        const token = registered.body.data.accessToken as string;

        const created = await request(app)
            .post('/api/v1/books')
            .set('Authorization', `Bearer ${token}`)
            .send({ title: 'Sách thử queue' });
        expect(created.status).toBe(201);
        const bookId = created.body.data.book.id as string;

        const inserted = await pool.query<{ id: string; type: string }>(
            `INSERT INTO jobs (type, ref_type, ref_id, created_by)
             VALUES ('BUILD_PREVIEW', 'BOOK', $1, $2),
                    ('PUBLISH_BOOK', 'BOOK', $1, $2)
             RETURNING id, type`,
            [bookId, userId],
        );
        const previewId = inserted.rows.find((row) => row.type === 'BUILD_PREVIEW')?.id;
        const publishId = inserted.rows.find((row) => row.type === 'PUBLISH_BOOK')?.id;
        expect(previewId).toBeDefined();
        expect(publishId).toBeDefined();

        let executions = 0;
        const worker = await startQueueWorker({
            handlers: {
                BUILD_PREVIEW: async ({ job, setProgress }) => {
                    if (job.id === previewId) executions += 1;
                    await setProgress(40);
                    return { token: 'preview-token', url: 'https://example.com/preview' };
                },
            },
            dispatchEveryMs: 0,
            pollingSeconds: 0.5,
            retryDelaySeconds: 1,
            expireSeconds: 30,
        });

        try {
            expect(await worker.boss.getQueue('BUILD_PREVIEW')).toMatchObject({
                expireInSeconds: 30,
                retryLimit: 2,
            });

            await vi.waitFor(
                async () => {
                    const { rows } = await pool.query<{ status: string; progress: number }>(
                        'SELECT status, progress FROM jobs WHERE id = $1',
                        [previewId],
                    );
                    expect(rows[0]).toMatchObject({ status: 'SUCCEEDED', progress: 100 });
                },
                { timeout: 10_000, interval: 100 },
            );

            await worker.tick();
            expect(executions).toBe(1);
            const { rows } = await pool.query<{ status: string }>(
                'SELECT status FROM jobs WHERE id = $1',
                [publishId],
            );
            expect(rows[0]?.status).toBe('QUEUED');
        } finally {
            await worker.stop();
        }

        await expect(worker.boss.getQueues()).rejects.toThrow();
        await worker.stop();
    });
});
