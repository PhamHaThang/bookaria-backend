import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { pool } from '../../db';
import { JobError } from '../../modules/jobs/jobs.types';
import { failAbandonedJob, failJob, runJob } from '../runner';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });

async function makeBookAndJob() {
    const email = `runner-${randomUUID()}@example.com`;
    const registered = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, displayName: 'Tác giả', password: 'Matkhau-123' });
    const userId = registered.body.data.user.id as string;
    const token = registered.body.data.accessToken as string;
    const created = await request(app)
        .post('/api/v1/books')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Sách thử worker' });
    const bookId = created.body.data.book.id as string;
    const inserted = await pool.query<{ id: string }>(
        `INSERT INTO jobs (type, ref_type, ref_id, created_by)
         VALUES ('PUBLISH_BOOK', 'BOOK', $1, $2) RETURNING id`,
        [bookId, userId],
    );
    return { jobId: (inserted.rows[0] as { id: string }).id, userId };
}

async function state(jobId: string) {
    const result = await pool.query<{
        status: string;
        attempts: number;
        progress: number;
        result: Record<string, unknown> | null;
        error: { code: string; message: string } | null;
    }>('SELECT status, attempts, progress, result, error FROM jobs WHERE id = $1', [jobId]);
    return result.rows[0];
}

suite('runJob', () => {
    it('records success, caps progress at 99 until completion, and notifies once', async () => {
        const { jobId, userId } = await makeBookAndJob();
        const outcome = await runJob(jobId, async ({ setProgress }) => {
            await setProgress(150);
            expect((await state(jobId))?.progress).toBe(99);
            return {
                versionNo: 1,
                slug: 'sach-thu-worker',
                url: 'https://example.com/sach-thu-worker',
            };
        });
        expect(outcome).toBe('done');
        expect(await state(jobId)).toMatchObject({
            status: 'SUCCEEDED',
            attempts: 1,
            progress: 100,
            result: {
                versionNo: 1,
                slug: 'sach-thu-worker',
                url: 'https://example.com/sach-thu-worker',
            },
            error: null,
        });
        const duplicate = await runJob(jobId, async () => {
            throw new Error('Không được chạy lại');
        });
        expect(duplicate).toBe('skipped');
        const notifications = await pool.query(
            'SELECT type FROM notifications WHERE user_id = $1',
            [userId],
        );
        expect(notifications.rows).toEqual([{ type: 'JOB_SUCCEEDED' }]);
    });

    it('requeues a temporary error, then fails after three attempts', async () => {
        const { jobId, userId } = await makeBookAndJob();
        const temporary = async () => {
            throw new JobError('STORAGE_UNAVAILABLE', 'Kho tệp chưa sẵn sàng', true);
        };
        for (const attempt of [1, 2]) {
            await expect(runJob(jobId, temporary)).rejects.toThrow('Kho tệp chưa sẵn sàng');
            expect(await state(jobId)).toMatchObject({ status: 'QUEUED', attempts: attempt });
        }
        expect(await runJob(jobId, temporary)).toBe('failed');
        expect(await state(jobId)).toMatchObject({ status: 'FAILED', attempts: 3 });
        expect((await state(jobId))?.error).toEqual({
            code: 'STORAGE_UNAVAILABLE',
            message: 'Kho tệp chưa sẵn sàng',
        });
        const notifications = await pool.query(
            'SELECT type FROM notifications WHERE user_id = $1',
            [userId],
        );
        expect(notifications.rows).toEqual([{ type: 'JOB_FAILED' }]);
    });

    it('does not retry an expected permanent error', async () => {
        const { jobId } = await makeBookAndJob();
        expect(
            await runJob(jobId, async () => {
                throw new JobError('BAD_MARKER', 'Ảnh không đạt yêu cầu');
            }),
        ).toBe('failed');
        expect(await state(jobId)).toMatchObject({ status: 'FAILED', attempts: 1 });
        expect((await state(jobId))?.error).toEqual({
            code: 'BAD_MARKER',
            message: 'Ảnh không đạt yêu cầu',
        });
    });

    it('rejects a handler result that does not match the job type', async () => {
        const { jobId } = await makeBookAndJob();
        expect(await runJob(jobId, async () => ({ versionNo: 1 }))).toBe('failed');
        expect((await state(jobId))?.error).toEqual({
            code: 'INVALID_RESULT',
            message: 'Kết quả của tác vụ không hợp lệ.',
        });
    });

    it('retries an unexpected error without exposing its internal message', async () => {
        const { jobId } = await makeBookAndJob();
        await expect(
            runJob(jobId, async () => {
                throw new Error('private database connection detail');
            }),
        ).rejects.toThrow('private database connection detail');
        expect(await state(jobId)).toMatchObject({ status: 'QUEUED', attempts: 1 });
        expect((await state(jobId))?.error).toEqual({
            code: 'INTERNAL_ERROR',
            message: 'Đã xảy ra lỗi, vui lòng thử lại.',
        });
    });

    it('marks a job failed only once', async () => {
        const { jobId, userId } = await makeBookAndJob();
        await pool.query(
            "UPDATE jobs SET status = 'RUNNING', attempts = 3, started_at = now() - interval '1 hour' WHERE id = $1",
            [jobId],
        );
        await failJob(jobId, { code: 'ABANDONED', message: 'Tác vụ quá hạn.' });
        await failJob(jobId, { code: 'ABANDONED', message: 'Tác vụ quá hạn.' });
        expect(await state(jobId)).toMatchObject({ status: 'FAILED', attempts: 3 });
        const notifications = await pool.query(
            'SELECT type FROM notifications WHERE user_id = $1',
            [userId],
        );
        expect(notifications.rows).toEqual([{ type: 'JOB_FAILED' }]);
    });

    it('reaper fails an overdue final attempt only once', async () => {
        const { jobId, userId } = await makeBookAndJob();
        await pool.query(
            "UPDATE jobs SET status = 'RUNNING', attempts = 3, started_at = now() - interval '1 hour' WHERE id = $1",
            [jobId],
        );

        expect(await failAbandonedJob(jobId, 60)).toBe(true);
        expect(await failAbandonedJob(jobId, 60)).toBe(false);
        expect(await state(jobId)).toMatchObject({
            status: 'FAILED',
            error: { code: 'ABANDONED', message: 'Tác vụ quá hạn sau lần thử cuối.' },
        });
        const notifications = await pool.query(
            'SELECT type FROM notifications WHERE user_id = $1',
            [userId],
        );
        expect(notifications.rows).toEqual([{ type: 'JOB_FAILED' }]);
    });

    it('reaper leaves a fresh attempt running', async () => {
        const { jobId } = await makeBookAndJob();
        await pool.query(
            "UPDATE jobs SET status = 'RUNNING', attempts = 3, started_at = now() WHERE id = $1",
            [jobId],
        );

        expect(await failAbandonedJob(jobId, 60)).toBe(false);
        expect(await state(jobId)).toMatchObject({ status: 'RUNNING', attempts: 3 });
    });
});
