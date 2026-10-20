import { Router } from 'express';
import { assetCategoriesRouter, assetsRouter } from './assets/assets.routes';
import { authRouter } from './auth/auth.routes';
import { bookRouter } from './books/books.routes';
import { healthRouter } from './health/health.routes';
import { jobsRouter } from './jobs/jobs.routes';
import { meRouter } from './me/me.routes';
import { bookPagesRouter, pagesRouter } from './pages/pages.routes';
import { authorPreviewRouter, publicPreviewRouter } from './previews/preview.routes';
import { publicRouter } from './public/public.routes';
import { publishRouter } from './publish/publish.routes';
import { statsRouter } from './stats/stats.routes';

export interface ApiRouterOptions {
    rateLimit: boolean;
}

export function createApiRouter(options: ApiRouterOptions) {
    const router = Router();
    router.use(healthRouter);
    router.use('/auth', authRouter({ rateLimit: options.rateLimit }));
    router.use('/me', meRouter({ rateLimit: options.rateLimit }));
    router.use('/books/:bookId/pages', bookPagesRouter());
    router.use('/books/:bookId/previews', authorPreviewRouter(options.rateLimit));
    router.use('/books/:bookId', publishRouter());
    router.use('/books/:bookId', statsRouter());
    router.use('/books', bookRouter());
    router.use('/pages', pagesRouter());
    router.use('/jobs', jobsRouter());
    router.use('/assets', assetsRouter({ rateLimit: options.rateLimit }));
    router.use('/asset-categories', assetCategoriesRouter());
    router.use('/public/previews', publicPreviewRouter(options.rateLimit));
    router.use('/public', publicRouter({ rateLimit: options.rateLimit }));
    return router;
}
