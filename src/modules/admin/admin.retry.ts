import { type Queryable, withTransaction } from '../../db';
import type { Auth } from '../../middlewares';
import { AppError } from '../../utils';
import { jobsRepository } from '../jobs/jobs.repository';
import type { JobRow } from '../jobs/jobs.types';
import { adminRepository } from './admin.repository';

export async function retryFailedJob(actor: Auth, jobId: string): Promise<string> {
    try {
        return await withTransaction(async (db) => {
            const job = await jobsRepository.lockJob(db, jobId);
            if (!job) throw new AppError('NOT_FOUND', 'Không tìm thấy job');
            // Kiểm tra job có đang chạy/thất bại hay không, nếu đang chạy/thất bại thì không cho retry
            if (job.status === 'QUEUED' || job.status === 'RUNNING')
                throw new AppError('JOB_IN_PROGRESS');
            if (job.status !== 'FAILED')
                throw new AppError('VALIDATION_ERROR', 'Chỉ có thể retry job đã thất bại');

            await lockRetryTarget(db, job);

            // Kiểm tra xem có job nào đang chạy cho cùng một target không
            if (await adminRepository.hasOpenJobForRef(db, job.ref_type, job.ref_id, job.id)) {
                throw new AppError('JOB_IN_PROGRESS');
            }

            if (job.type === 'OPTIMIZE_ASSET') {
                const result = await db.query(
                    `UPDATE assets SET status='PROCESSING', error=NULL WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND status='FAILED' AND type IN ('MODEL', 'AUDIO', 'VIDEO')`,
                    [job.ref_id, job.created_by],
                );
                if (result.rowCount !== 1) {
                    throw new AppError(
                        'VALIDATION_ERROR',
                        'Asset không còn đủ điều kiện thử tối ưu lại.',
                    );
                }
            }
            const newJobId = await adminRepository.insertRetryJob(db, job.id);
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'RETRY_JOB',
                job.id,
                {
                    type: job.type,
                    ref: { type: job.ref_type, id: job.ref_id },
                    previousJobId: job.id,
                    newJobId,
                },
                'JOB',
            );
            return newJobId;
        });
    } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new AppError('JOB_IN_PROGRESS');
        throw error;
    }
}
async function lockRetryTarget(db: Queryable, job: JobRow): Promise<void> {
    if (!job.created_by) throw new AppError('VALIDATION_ERROR', 'Job không còn tác giả.');
    let owner: string | undefined;
    if (job.type === 'OPTIMIZE_ASSET' && job.ref_type === 'ASSET') {
        const result = await db.query<{ owner_id: string | null }>(
            'SELECT owner_id FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
            [job.ref_id],
        );
        owner = result.rows[0]?.owner_id ?? undefined;
    } else if (job.type === 'SCORE_MARKER' && job.ref_type === 'PAGE') {
        const result = await db.query<{ owner_id: string }>(
            `SELECT b.owner_id FROM books b JOIN pages p ON p.book_id=b.id
             WHERE p.id=$1 AND b.deleted_at IS NULL AND b.taken_down_at IS NULL FOR UPDATE OF b`,
            [job.ref_id],
        );
        owner = result.rows[0]?.owner_id;
    } else if (
        ['PUBLISH_BOOK', 'BUILD_PREVIEW', 'EXPORT_PDF'].includes(job.type) &&
        job.ref_type === 'BOOK'
    ) {
        const result = await db.query<{ owner_id: string }>(
            'SELECT owner_id FROM books WHERE id=$1 AND deleted_at IS NULL AND taken_down_at IS NULL FOR UPDATE',
            [job.ref_id],
        );
        owner = result.rows[0]?.owner_id;
    }
    if (!owner || owner !== job.created_by)
        throw new AppError('VALIDATION_ERROR', 'Đối tượng đã bị xóa, gỡ hoặc đổi chủ sở hữu.');
    const user = await db.query<{ status: string }>(
        'SELECT status FROM users WHERE id=$1 FOR SHARE',
        [owner],
    );
    if (user.rows[0]?.status !== 'ACTIVE')
        throw new AppError('VALIDATION_ERROR', 'Tác giả không còn hoạt động.');
}
