import { Router } from 'express';
import { healthRouter } from './health/health.routes';

export const apiRouter = Router();

apiRouter.use(healthRouter);
