import type { JobRefType, JobStatus, JobType } from '../../schema';

export interface JobRow {
    id: string;
    type: JobType;
    status: JobStatus;
    ref_type: JobRefType;
    ref_id: string;
    payload: Record<string, unknown>;
    result: Record<string, unknown> | null;
    progress: number;
    attempts: number;
    error: { code: string; message: string } | null;
    created_by: string | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}

export interface BookOfJob {
    book_id: string;
    title: string;
}

export interface JobContext {
    job: JobRow;
    setProgress(percent: number): Promise<void>;
    signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export type RunOutcome = 'done' | 'failed' | 'skipped';

/**
 * Throw JobError từ trong handler để báo lỗi nghiệp vụ.
 */
export class JobError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retry = false,
    ) {
        super(message);
        this.name = 'JobError';
    }
}
