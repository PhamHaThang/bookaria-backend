import { Router } from 'express';
import { requireAuth, requireVerifiedEmail } from '../../middlewares';
import { jobsController } from './jobs.controller';

export const jobsRouter = () => {
    const router = Router();
    router.use(requireAuth, requireVerifiedEmail);

    // [GET] /jobs/:jobId
    router.get('/:jobId', jobsController.getJobOwnedByUser);

    return router;
};
