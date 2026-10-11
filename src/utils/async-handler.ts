import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Request Express với `body`, `query`, `params` có kiểu bất kỳ (kể cả `ValidatedRequest<...>`). */
type AnyRequest = Request<Request['params'], unknown, unknown, object>;

/**
 * Bọc controller bất đồng bộ: lỗi (throw hoặc reject) được chuyển cho `errorMiddleware`.
 *
 * Controller được khai báo kiểu request cụ thể (`ValidatedRequest<LoginBody>`...). Kiểu đó là lời
 * khai báo: `validateMiddleware` ở route mới là nơi bảo đảm dữ liệu đúng. Hàm trả về `RequestHandler`
 * thông thường để ghép được với các middleware khác trong `router.get(...)`.
 */
export const asyncHandler =
    <Req extends AnyRequest = Request>(
        fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
    ): RequestHandler =>
    (req, res, next) => {
        fn(req as unknown as Req, res, next).catch(next);
    };
