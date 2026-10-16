import { Router } from 'express';
import { rateLimitMiddleware } from '../../middlewares';
import { publicController } from './public.controller';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export const publicRouter = (options: { rateLimit: boolean }) => {
    const router = Router();
    const enabled = options.rateLimit;
    const eventLimiter = rateLimitMiddleware({
        windowMs: MINUTE, // 1 minute
        limit: 60, // 60 requests per minute
        enabled,
    });
    const reportLimiter = rateLimitMiddleware({
        windowMs: HOUR, // 1 hour
        limit: 20, // 20 requests per hour
        enabled,
    });

    // [GET] /public/books
    router.get('/books', publicController.getPublicBooks);

    // [GET] /public/books/:slug
    router.get('/books/:slug', publicController.getPublicBook);

    // [GET] /public/authors/:authorId
    router.get('/authors/:authorId', publicController.getAuthorProfile);

    // [POST] /public/events
    router.post('/events', eventLimiter, publicController.recordViewEvents);

    // [POST] /public/books/:slug/reports
    router.post('/books/:slug/reports', reportLimiter, publicController.reportBook);

    return router;
};
