import { Router } from 'express';
import { requireAuth, requireVerifiedEmail } from '../../middlewares';
import { statsController } from './stats.controller';

export const statsRouter = () => {
    const router = Router({ mergeParams: true });

    // [GET] /books/:bookId/stats
    router.get('/stats', requireAuth, requireVerifiedEmail, statsController.getTotalStats);

    return router;
};

export const studioReadingStatsRouter = () => {
    const router = Router();
    router.get(
        '/reading-stats',
        requireAuth,
        requireVerifiedEmail,
        statsController.getStudioReadingStats,
    );
    return router;
};
