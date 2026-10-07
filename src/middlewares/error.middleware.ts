import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config';
import { type ApiError, apiError, formatZodError, HTTP_STATUS } from '../schema';
import { AppError } from '../utils';

export const errorMiddleware: ErrorRequestHandler = (
    err: AppError | ZodError,
    _req: Request,
    res: Response,
    _next: NextFunction,
) => {
    const id = String(res.locals.requestId);
    let body: ApiError;
    let status: number;
    if (err instanceof AppError) {
        status = err.status;
        body = apiError(err.code, id, {
            message: err.message,
            details: err.details,
        });
    } else if (err instanceof ZodError) {
        status = HTTP_STATUS.VALIDATION_ERROR;
        body = apiError('VALIDATION_ERROR', id, {
            details: formatZodError(err),
        });
    } else if (isPayloadTooLarge(err)) {
        status = HTTP_STATUS.FILE_TOO_LARGE;
        body = apiError('FILE_TOO_LARGE', id);
    } else {
        status = HTTP_STATUS.INTERNAL_ERROR;
        logger.error({ err, requestId: id }, 'Unhandled error');
        body = apiError('INTERNAL_ERROR', id);
    }
    res.status(status).json(body);
};

/**
 * Check if the error is a payload too large error.
 */
const isPayloadTooLarge = (err: unknown) =>
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.too.large';
