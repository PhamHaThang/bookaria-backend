import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Middleware to generate a unique request ID for each incoming request.
 */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
    const id = `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    req.headers['x-request-id'] = id;

    next();
};
