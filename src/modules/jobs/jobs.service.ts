import { pool } from '../../db';
import { JobSchema } from '../../schema';
import { AppError } from '../../utils';
import { jobsRepository } from './jobs.repository';
import type { JobRow } from './jobs.types';

export const jobsService = {
    async getJobOwnedByUser(userId: string, jobId: string) {
        const rows = await jobsRepository.getJobOwnedByUser(pool, userId, jobId);
        if (!rows) throw new AppError('NOT_FOUND', 'Không tìm thấy job');
        return toJob(rows);
    },
};

export function toJob(row: JobRow) {
    return JobSchema.parse({
        id: row.id,
        type: row.type,
        status: row.status,
        progress: row.progress,
        ref: { type: row.ref_type, id: row.ref_id },
        result: row.result,
        error: row.error,
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    });
}
