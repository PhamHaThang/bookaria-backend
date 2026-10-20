import { type Request, type Response, Router } from 'express';
import { getAuth, rateLimitMiddleware, requireAuth } from '../../middlewares';
import { CreatePreviewBodySchema, IdSchema } from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { createPreview, previewReader } from './preview.service';

function noStore(res: Response) {
    res.set({
        'Cache-Control': 'no-store, private',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
    });
}

export function authorPreviewRouter(rateLimitEnabled: boolean) {
    const router = Router({ mergeParams: true });
    router.use(requireAuth);
    router.use((_req, res, next) => {
        noStore(res);
        next();
    });
    router.post(
        '/',
        rateLimitMiddleware({
            windowMs: 60 * 60_000,
            limit: 30,
            enabled: rateLimitEnabled,
            key: (_req, res) => getAuth(res).userId,
        }),
        asyncHandler(async (req: Request, res: Response) => {
            const bookId = IdSchema.safeParse(req.params.bookId);
            if (!bookId.success) throw new AppError('NOT_FOUND');
            const body = CreatePreviewBodySchema.parse(req.body);
            res.status(202).json({
                data: await createPreview(getAuth(res).userId, bookId.data, body),
            });
        }),
    );
    return router;
}

export function publicPreviewRouter(rateLimitEnabled: boolean, reader = previewReader) {
    const router = Router();
    router.use((_req, res, next) => {
        noStore(res);
        next();
    });
    router.use(rateLimitMiddleware({ windowMs: 60_000, limit: 120, enabled: rateLimitEnabled }));
    router.get(
        '/:token/groups/:group',
        asyncHandler(async (req: Request, res: Response) => {
            const group = req.params.group;
            if (typeof group !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(group))
                throw new AppError('NOT_FOUND');
            const abort = new AbortController();
            const cancel = () => abort.abort();
            res.once('close', cancel);
            try {
                const result = await reader.group(
                    String(req.params.token),
                    Number(group),
                    abort.signal,
                );
                res.set('Expires', result.expiresAt.toUTCString());
                res.type('application/octet-stream').send(result.bytes);
            } finally {
                res.off('close', cancel);
            }
        }),
    );
    router.get(
        '/:token',
        asyncHandler(async (req: Request, res: Response) => {
            const result = await reader.manifest(String(req.params.token));
            res.set('Expires', result.expiresAt.toUTCString());
            res.json({ data: result.manifest });
        }),
    );
    return router;
}
