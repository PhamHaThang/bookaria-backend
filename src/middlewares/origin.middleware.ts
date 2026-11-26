import type { RequestHandler } from 'express';
import { corsOrigins } from '../config';
import { AppError } from '../utils';

/** Require a trusted `Origin` (or `Sec-Fetch-Site: same-origin` when omitted) on cookie-authenticated endpoints. */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
    const origin = req.get('origin');
    if (origin) {
        if (!corsOrigins.includes(origin)) {
            next(new AppError('FORBIDDEN', 'Nguồn gửi yêu cầu không được phép.'));
            return;
        }
        next();
        return;
    }
    if (req.get('sec-fetch-site') === 'same-origin') {
        next();
        return;
    }
    next(new AppError('FORBIDDEN', 'Nguồn gửi yêu cầu không được phép.'));
};
