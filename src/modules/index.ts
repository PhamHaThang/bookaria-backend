import { Router } from 'express';
import { assetCategoriesRouter, assetsRouter } from './assets/assets.routes';
import { authRouter } from './auth/auth.routes';
import { bookRouter } from './books/books.routes';
import { healthRouter } from './health/health.routes';
import { meRouter } from './me/me.routes';

export interface ApiRouterOptions {
    rateLimit: boolean;
}

export function createApiRouter(options: ApiRouterOptions) {
    const router = Router();
    router.use(healthRouter);
    router.use('/auth', authRouter({ rateLimit: options.rateLimit }));
    router.use('/me', meRouter({ rateLimit: options.rateLimit }));
    router.use('/books', bookRouter());
    router.use('/assets', assetsRouter({ rateLimit: options.rateLimit }));
    router.use('/asset-categories', assetCategoriesRouter());
    return router;
}
