import { Router } from 'express';
import { requireAuth } from '../../middlewares';
import { statsController } from './stats.controller';

export const statsRouter = () => {
    const router = Router({ mergeParams: true });

    // [GET] /books/:bookId/stats
    router.get('/stats', requireAuth, statsController.getTotalStats);

    return router;
};
