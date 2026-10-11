import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Bọc controller bất đồng bộ: lỗi (throw hoặc reject) được chuyển cho `errorMiddleware`.
 * Controller tự parse `req.body` / `req.query` bằng schema; `ZodError` thành 400 VALIDATION_ERROR.
 */
export const asyncHandler =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
    (req, res, next) => {
        fn(req, res, next).catch(next);
    };
