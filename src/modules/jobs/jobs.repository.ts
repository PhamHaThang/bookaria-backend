import type { Queryable } from '../../db';
import type { JobRefType, JobType } from '../../schema';
import type { BookOfJob, JobRow } from './jobs.types';

const COLUMNS = `id, type, status, ref_type, ref_id, payload, result, progress, attempts, error, created_by, created_at, started_at, finished_at`;

export const jobsRepository = {
    async getJobOwnedByUser(
        db: Queryable,
        userId: string,
        jobId: string,
    ): Promise<JobRow | undefined> {
        const { rows } = await db.query<JobRow>(
            `
            SELECT ${COLUMNS}
            FROM jobs
            WHERE id = $1 AND created_by = $2
        `,
            [jobId, userId],
        );
        return rows[0];
    },

    async lockJob(db: Queryable, jobId: string): Promise<JobRow | undefined> {
        const { rows } = await db.query<JobRow>(
            `SELECT ${COLUMNS}
            FROM jobs
            WHERE id = $1 FOR UPDATE`,
            [jobId],
        );
        return rows[0];
    },

    async getQueuedJobs(
        db: Queryable,
        types: string[],
        limit: number,
        after?: {
            createdAt: Date;
            id: string;
        },
    ): Promise<{ id: string; type: JobType; created_at: Date }[]> {
        if (types.length === 0) return [];
        const { rows } = await db.query<{ id: string; type: JobType; created_at: Date }>(
            `SELECT id, type, created_at FROM jobs
            WHERE status = 'QUEUED'
                AND type = ANY($1::job_type[])
                AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
            ORDER BY created_at, id
            LIMIT $2`,
            [types, limit, after?.createdAt ?? null, after?.id ?? null],
        );
        return rows;
    },

    async startAttempt(db: Queryable, jobId: string): Promise<void> {
        await db.query(
            `UPDATE jobs
            SET status = 'RUNNING', started_at = NOW(), attempts = attempts + 1, progress = 0, error = NULL, finished_at = NULL
            WHERE id = $1`,
            [jobId],
        );
    },

    async setProgress(
        db: Queryable,
        jobId: string,
        attempt: number,
        progress: number,
    ): Promise<void> {
        await db.query(
            `UPDATE jobs
            SET progress = $3
            WHERE id = $1 AND status = 'RUNNING' AND attempts = $2 AND progress < $3`,
            [jobId, attempt, progress],
        );
    },

    async markJobAsSucceeded(
        db: Queryable,
        jobId: string,
        result: Record<string, unknown>,
    ): Promise<void> {
        await db.query(
            `UPDATE jobs
            SET status = 'SUCCEEDED', progress = 100, result = $2::jsonb, error = NULL, finished_at = NOW()
            WHERE id = $1`,
            [jobId, JSON.stringify(result)],
        );
    },
    async markJobAsRetryable(
        db: Queryable,
        jobId: string,
        error: { code: string; message: string },
    ): Promise<void> {
        await db.query(
            `UPDATE jobs
            SET status = 'QUEUED', progress = 0, error = $2::jsonb
            WHERE id = $1`,
            [jobId, JSON.stringify(error)],
        );
    },
    async markJobAsFailed(
        db: Queryable,
        jobId: string,
        error: { code: string; message: string },
    ): Promise<void> {
        await db.query(
            `UPDATE jobs
            SET status = 'FAILED', error = $2::jsonb, finished_at = NOW()
            WHERE id = $1`,
            [jobId, JSON.stringify(error)],
        );
    },

    // Lấy danh sách các job đang chạy mà đã vượt quá số lần thử tối đa và thời gian chạy lâu hơn một khoảng thời gian nhất định
    async getAbandonedJobs(
        db: Queryable,
        maxAttempts: number,
        seconds: number,
        limit: number,
    ): Promise<{ id: string }[]> {
        const { rows } = await db.query<{ id: string }>(
            `SELECT id FROM jobs
            WHERE status = 'RUNNING'
                AND attempts >= $1
                AND started_at < NOW() - MAKE_INTERVAL(secs => $2::double precision)
            ORDER BY started_at, id
            LIMIT $3`,
            [maxAttempts, seconds, limit],
        );
        return rows;
    },

    async lockAbandonedJob(
        db: Queryable,
        jobId: string,
        maxAttempts: number,
        seconds: number,
    ): Promise<JobRow | undefined> {
        const { rows } = await db.query<JobRow>(
            `SELECT ${COLUMNS} FROM jobs
            WHERE id = $1
                AND status = 'RUNNING'
                AND attempts >= $2
                AND started_at < NOW() - MAKE_INTERVAL(secs => $3::double precision)
            FOR UPDATE`,
            [jobId, maxAttempts, seconds],
        );
        return rows[0];
    },

    async getBookOfJob(
        db: Queryable,
        refType: JobRefType,
        refId: string,
    ): Promise<BookOfJob | undefined> {
        const sql =
            refType === 'BOOK'
                ? `SELECT b.id AS book_id, b.title
                FROM books b
                WHERE b.id = $1`
                : refType === 'PAGE'
                  ? `SELECT b.id AS book_id, b.title
                    FROM pages p
                    JOIN books b ON p.book_id = b.id
                    WHERE p.id = $1`
                  : undefined;
        if (!sql) return undefined;
        const { rows } = await db.query<BookOfJob>(sql, [refId]);
        return rows[0];
    },
};
