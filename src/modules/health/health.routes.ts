import { type Request, type Response, Router } from 'express';
import { env } from '../../config';
import type { HealthResponse } from '../../schema';
import { ok } from '../../utils';

export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response<HealthResponse>) => {
    ok(res, {
        status: 'OK',
        environment: env.NODE_ENV,
        timestamp: new Date().toISOString(),
    });
});
