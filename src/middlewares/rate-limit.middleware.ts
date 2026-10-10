import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { AppError } from '../utils';

interface RateLimitOptions {
    windowMs: number;
    limit: number;
    enabled: boolean;
    /** Khóa giới hạn. Mặc định theo IP. */
    key?: (req: Request, res: Response) => string;
    /** Request thành công không bị tính. */
    skipSuccessfulRequests?: boolean;
}

export function rateLimitMiddleware(options: RateLimitOptions) {
    return rateLimit({
        windowMs: options.windowMs,
        limit: options.limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
        skip: () => !options.enabled,
        keyGenerator: (req, res) =>
            options.key ? options.key(req, res) : ipKeyGenerator(req.ip ?? ''),
        handler: (req, res, next) => {
            const resetTime = (req as { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
            const retryAfterSeconds = Math.max(
                1,
                resetTime
                    ? Math.ceil((resetTime.getTime() - Date.now()) / 1000)
                    : Math.ceil(options.windowMs / 1000),
            );
            res.setHeader('Retry-After', String(retryAfterSeconds));
            next(
                new AppError('RATE_LIMITED', 'Bạn thao tác quá nhanh, vui lòng thử lại sau.', {
                    retryAfterSeconds,
                }),
            );
        },
    });
}

/**
 * Khóa theo cặp IP + email (không chỉ email): kẻ tấn công chỉ làm hết lượt của chính IP của họ,
 * không khóa được người dùng thật ở nơi khác.
 */
export const emailKeyGenerator = (req: Request) => {
    const ip = ipKeyGenerator(req.ip ?? '');
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' ? `${ip}|email:${email.trim().toLowerCase()}` : ip;
};
