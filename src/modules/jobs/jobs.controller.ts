import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import { IdSchema } from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { jobsService } from './jobs.service';
export const jobsController = {
    getJobOwnedByUser: asyncHandler(async (req: Request, res: Response) => {
        const jobId = IdSchema.safeParse(req.params.jobId);
        if (!jobId.success) throw new AppError('NOT_FOUND', 'Không tìm thấy job');
        const job = await jobsService.getJobOwnedByUser(getAuth(res).userId, jobId.data);
        res.json({
            data: job,
        });
    }),
};
