import type { Queryable } from '../../db';
import type { JobRow } from '../../modules/jobs/jobs.types';
import { optimizeRepository } from '../optimize/repo';

/** Cập nhật đối tượng của job khi không còn lượt thử. */
export async function onJobFailed(db: Queryable, job: JobRow, message: string): Promise<void> {
    if (job.type === 'OPTIMIZE_ASSET' && job.ref_type === 'ASSET' && job.created_by) {
        await optimizeRepository.saveFailed(db, job.ref_id, job.created_by, message);
    }
}
