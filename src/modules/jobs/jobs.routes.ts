import { Router } from 'express';
import { requireAuth } from '../../middlewares';
import { jobsController } from './jobs.controller';

export const jobsRouter = () => {
    const router = Router();
    router.use(requireAuth);

    // [GET] /jobs/:jobId
    router.get('/:jobId', jobsController.getJobOwnedByUser);

    return router;
};
