import type { RequestHandler } from 'express';
import { corsOrigins } from '../config';
import { AppError } from '../utils';

export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
    const origin = req.get('origin');
    if (origin && !corsOrigins.includes(origin)) {
        next(new AppError('FORBIDDEN', 'Nguồn gửi yêu cầu không được phép.'));
        return;
    }
    next();
};
