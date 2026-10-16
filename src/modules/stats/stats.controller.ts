import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import { IdSchema, StatsQuerySchema } from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { statsService } from './stats.service';
export const statsController = {
    getTotalStats: asyncHandler(async (req: Request, res: Response) => {
        const id = IdSchema.safeParse(req.params.bookId);
        if (!id.success) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
        const query = StatsQuerySchema.parse(req.query);
        const userId = getAuth(res).userId;
        const data = await statsService.getTotalStats(userId, id.data, query);
        res.json({
            data,
        });
    }),
};
