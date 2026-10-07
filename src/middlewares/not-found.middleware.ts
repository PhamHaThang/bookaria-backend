import type { RequestHandler } from 'express';
import { AppError } from '../utils';

export const notFoundMiddleware: RequestHandler = (req, _res, next) => {
    next(new AppError('NOT_FOUND', `Không tìm thấy: ${req.method} ${req.originalUrl}`));
};
