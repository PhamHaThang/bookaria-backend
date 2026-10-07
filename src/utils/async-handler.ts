import type { NextFunction, Request, Response } from 'express';

export const asyncHandler =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
        fn(req, res, next).catch(next);
    };
