import { logger } from '../config';
import { pool, type Queryable, withTransaction } from '../db';
import { jobsRepository } from '../modules/jobs/jobs.repository';
import {
    JobError,
    type JobHandler,
    type JobRow,
    type RunOutcome,
} from '../modules/jobs/jobs.types';
import { notificationsService } from '../modules/notifications/notifications.service';
import { JobResultsSchema, type JobType } from '../schema';
import { onJobFailed } from './handlers/failure';

export const MAX_ATTEMPTS = 3;

const NOTIFY_ON_SUCCESS: ReadonlySet<JobType> = new Set(['PUBLISH_BOOK', 'EXPORT_PDF']);
const GENERIC_ERROR = { code: 'INTERNAL_ERROR', message: 'Đã xảy ra lỗi, vui lòng thử lại.' };
type PublicError = { code: string; message: string };

/** Đánh dấu job thất bại. */
export async function failJob(jobId: string, error: PublicError): Promise<void> {
    await withTransaction(async (db) => {
        const job = await jobsRepository.lockJob(db, jobId);
        if (!job || job.status === 'SUCCEEDED' || job.status === 'FAILED') return;
        await settleFailedJob(db, job, error);
    });
}

/** Đánh dấu job thất bại nếu nó vượt quá số lần thử tối đa và thời gian chạy lâu hơn một khoảng thời gian nhất định. Được gọi bởi reaper. */
export async function failAbandonedJob(jobId: string, seconds: number): Promise<boolean> {
    return withTransaction(async (db) => {
        const job = await jobsRepository.lockAbandonedJob(db, jobId, MAX_ATTEMPTS, seconds);
        if (!job) return false;
        await settleFailedJob(db, job, {
            code: 'ABANDONED',
            message: 'Tác vụ quá hạn sau lần thử cuối.',
        });
        return true;
    });
}

/** Chạy một attempt của job.
 * Throw lỗi tạm thời để Queue thử lại
 * return 'done' nếu job thành công
 * return 'failed' nếu job thất bại
 * return 'skipped' nếu job đã được xử lý hoặc lần chạy này đã cũ
 * */
export async function runJob(
    jobId: string,
    handler: JobHandler,
    signal: AbortSignal = new AbortController().signal,
): Promise<RunOutcome> {
    // 1. Nhận, khóa job và tăng số lần thử, tránh hai worker nhận cùng một lần.
    const claimed = await withTransaction(async (db) => {
        const job = await jobsRepository.lockJob(db, jobId);
        if (!job || job.status === 'SUCCEEDED' || job.status === 'FAILED') return undefined;
        if (job.attempts >= MAX_ATTEMPTS) return 'exhausted' as const;
        await jobsRepository.startAttempt(db, jobId);
        return { ...job, status: 'RUNNING' as const, attempts: job.attempts + 1 };
    });
    if (claimed === undefined) return 'skipped';
    if (claimed === 'exhausted') {
        await failJob(jobId, {
            code: 'MAX_ATTEMPTS',
            message: 'Tác vụ đã vượt quá số lần thử cho phép.',
        });
        return 'failed';
    }

    let commit: ((db: Queryable) => Promise<void>) | undefined;
    // 2. Chạy handler, ghi kết quả hoặc lỗi.
    try {
        if (signal.aborted) throw new JobError('INTERRUPTED', 'Worker đã dừng.', true);
        const output = await handler({
            job: claimed,
            signal,
            setProgress: async (percent) => {
                if (!Number.isFinite(percent)) throw new RangeError('Tiến độ phải là số hữu hạn');
                const progress = Math.min(99, Math.max(0, Math.round(percent)));
                await jobsRepository.setProgress(pool, jobId, claimed.attempts, progress);
            },
            onSuccess: (callback) => {
                if (commit) throw new Error('Only one success callback may be registered');
                commit = callback;
            },
        });

        // Chỉ lưu kết quả đúng loại job.
        const checked = JobResultsSchema[claimed.type].safeParse(output);
        if (!checked.success) {
            throw new JobError('INVALID_RESULT', 'Kết quả của tác vụ không hợp lệ.');
        }

        // Lần thử cũ không được ghi đè kết quả của lần mới.
        return await withTransaction(async (db): Promise<RunOutcome> => {
            if (!(await isCurrentAttempt(db, claimed))) return 'skipped';
            if (signal.aborted) throw new JobError('INTERRUPTED', 'Worker đã dừng.', true);
            if (commit) await commit(db);
            if (signal.aborted) throw new JobError('INTERRUPTED', 'Worker đã dừng.', true);
            await jobsRepository.markJobAsSucceeded(db, jobId, checked.data);
            if (NOTIFY_ON_SUCCESS.has(claimed.type)) await notifySuccess(db, claimed);
            return 'done';
        });
    } catch (cause) {
        const known = cause instanceof JobError;
        if (!known) logger.error({ err: cause, jobId }, 'Job handler gặp lỗi');
        const error = known ? { code: cause.code, message: cause.message } : GENERIC_ERROR;
        const shouldRetry = (!known || cause.retry) && claimed.attempts < MAX_ATTEMPTS;

        // Ghi lỗi và thông báo cùng giao dịch; còn lượt thì trả về hàng đợi.
        const disposition = await withTransaction(async (db): Promise<RunOutcome | 'retry'> => {
            if (!(await isCurrentAttempt(db, claimed))) return 'skipped';
            if (shouldRetry) {
                await jobsRepository.markJobAsRetryable(db, jobId, error);
                return 'retry';
            }
            await settleFailedJob(db, claimed, error);
            return 'failed';
        });
        if (disposition === 'retry') {
            throw cause instanceof Error ? cause : new Error(String(cause));
        }
        return disposition;
    }
}

async function isCurrentAttempt(db: Queryable, job: JobRow): Promise<boolean> {
    const current = await jobsRepository.lockJob(db, job.id);
    return current?.status === 'RUNNING' && current.attempts === job.attempts;
}

async function settleFailedJob(db: Queryable, job: JobRow, error: PublicError): Promise<void> {
    await jobsRepository.markJobAsFailed(db, job.id, error);
    await onJobFailed(db, job, error.message);
    await notifyFailure(db, job);
}

async function notifyFailure(db: Queryable, job: JobRow): Promise<void> {
    if (!job.created_by) return;
    const book = await jobsRepository.getBookOfJob(db, job.ref_type, job.ref_id);
    if (!book) return;
    await notificationsService.notify(db, job.created_by, {
        type: 'JOB_FAILED',
        job: job.type,
        bookId: book.book_id,
        bookTitle: book.title,
    });
}

async function notifySuccess(db: Queryable, job: JobRow): Promise<void> {
    if (!job.created_by) return;
    const book = await jobsRepository.getBookOfJob(db, job.ref_type, job.ref_id);
    if (!book) return;
    await notificationsService.notify(db, job.created_by, {
        type: 'JOB_SUCCEEDED',
        job: job.type,
        bookId: book.book_id,
        bookTitle: book.title,
    });
}
