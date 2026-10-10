import { Router } from 'express';
import { authRouter } from './auth/auth.routes';
import { healthRouter } from './health/health.routes';

export interface ApiRouterOptions {
    rateLimit: boolean;
}

export function createApiRouter(options: ApiRouterOptions) {
    const router = Router();
    router.use(healthRouter);
    router.use('/auth', authRouter({ rateLimit: options.rateLimit }));
    return router;
}
