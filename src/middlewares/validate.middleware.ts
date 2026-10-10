import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

export type ValidatedRequest<
    TBody = unknown,
    TParams = Request['params'],
    TQuery = Request['query'],
> = Request<TParams, unknown, TBody, TQuery>;

type ValidateTarget = 'params' | 'query' | 'body';
type ValidateSchemas = Partial<Record<ValidateTarget, ZodType>>;

const TARGETS: readonly ValidateTarget[] = ['params', 'query', 'body'];

/**
 * Kiểm tra `req.params`, `req.query`, `req.body` bằng schema zod.
 *
 * - Hợp lệ: thay giá trị gốc bằng dữ liệu đã parse (đã ép kiểu, cắt khoảng trắng, thêm giá trị mặc định, bỏ trường lạ) rồi gọi `next()`.
 * - Sai: gom lỗi của mọi phần và chuyển cho `errorMiddleware` thành `VALIDATION_ERROR` (400).
 *
 * Dùng: `router.post('/login', validateMiddleware({ body: LoginBodySchema }), authController.login)`
 */
export function validateMiddleware(schemas: ValidateSchemas) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const parsed: Partial<Record<ValidateTarget, unknown>> = {};
        const issues: ZodError['issues'] = [];

        for (const target of TARGETS) {
            const schema = schemas[target];
            if (!schema) continue;
            const result = schema.safeParse(req[target]);
            if (result.success) {
                parsed[target] = result.data;
            } else {
                issues.push(...result.error.issues);
            }
        }

        if (issues.length > 0) {
            next(new ZodError(issues));
            return;
        }
        for (const target of TARGETS) {
            if (target in parsed) assign(req, target, parsed[target]);
        }
        next();
    };
}

function assign(req: Request, target: ValidateTarget, value: unknown): void {
    if (target === 'query') {
        Object.defineProperty(req, 'query', {
            value,
            writable: true,
            configurable: true,
            enumerable: true,
        });
        return;
    }
    req[target] = value as never;
}
