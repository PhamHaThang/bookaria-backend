import { type Request, type Response, Router } from 'express';
import { pool, withTransaction } from '../../db';
import { getMediaStorage } from '../../lib';
import { pageImageDelivery } from '../../lib/page-image';
import { getAuth, rateLimitMiddleware, requireAuth } from '../../middlewares';
import { IdSchema, PrintLayoutSchema, PrintPdfBodySchema } from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { coverQrRect, markerRect, qrRect, validatePrintLayout } from '../../worker/print/layout';
import { JobError } from '../jobs/jobs.types';
import { printRepository, readPrintVersion } from './print.repository';

export function printRouter(enabled: boolean) {
    const router = Router({ mergeParams: true });
    router.use(requireAuth);
    router.get(
        '/print-layout',
        asyncHandler(async (req: Request, res: Response) => {
            const id = IdSchema.safeParse(req.params.bookId);
            if (!id.success) throw new AppError('NOT_FOUND');
            try {
                const version = await readPrintVersion(pool, getAuth(res).userId, id.data);
                const storage = getMediaStorage();
                if (!storage) throw new AppError('INTERNAL_ERROR');
                const source = version.source;
                res.setHeader('Cache-Control', 'no-store');
                const q = coverQrRect({ kind: 'PRINT', qrMode: 'COVER_ONLY', bleedMm: 3 });
                res.json({
                    data: PrintLayoutSchema.parse({
                        versionId: version.id,
                        versionNo: version.version_no,
                        title: source.title,
                        coverUrl: source.cover
                            ? storage.deliveryUrl({
                                  resourceType: 'image',
                                  publicId: source.cover.publicId,
                                  format: source.cover.format,
                              })
                            : null,
                        widthMm: source.widthMm,
                        heightMm: source.heightMm,
                        coverQr: { pageId: null, xMm: q.x, yMm: q.y, sizeMm: q.width },
                        pages: source.pages.map((p) => {
                            const box = markerRect(source, p);
                            let qr = null;
                            if (p.marker.mode === 'BOOKARIA_MARKER') {
                                try {
                                    const rect = qrRect(source, p);
                                    qr = {
                                        pageId: p.pageId,
                                        xMm: rect.x,
                                        yMm: rect.y,
                                        sizeMm: rect.width,
                                    };
                                } catch {
                                    /* No default QR slot; the editor explains the limitation. */
                                }
                            }
                            return {
                                pageId: p.pageId,
                                title: p.title,
                                imageUrl: pageImageDelivery(
                                    storage,
                                    p.image.publicId,
                                    source.heightMm / source.widthMm,
                                ).url,
                                markerMode: p.marker.mode,
                                defaultQr: qr,
                                marker:
                                    p.marker.mode === 'BOOKARIA_MARKER' && box
                                        ? {
                                              number: p.marker.number,
                                              imageUrl: storage.deliveryUrl({
                                                  resourceType: 'image',
                                                  publicId: p.marker.image.publicId,
                                                  format: p.marker.image.format,
                                              }),
                                              xMm: box.x,
                                              yMm: box.y,
                                              sizeMm: box.width,
                                          }
                                        : null,
                            };
                        }),
                    }),
                });
            } catch (error) {
                if (error instanceof JobError)
                    throw new AppError(
                        error.code === 'PRINT_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR',
                        error.message,
                    );
                throw error;
            }
        }),
    );
    router.post(
        '/print-pdf',
        rateLimitMiddleware({
            windowMs: 60 * 60_000,
            limit: 20,
            enabled,
            key: (_req, res) => getAuth(res).userId,
        }),
        asyncHandler(async (req: Request, res: Response) => {
            const id = IdSchema.safeParse(req.params.bookId);
            if (!id.success) throw new AppError('NOT_FOUND');
            const body = PrintPdfBodySchema.parse(req.body),
                ownerId = getAuth(res).userId;
            try {
                const result = await withTransaction(async (db) => {
                    const version = await readPrintVersion(
                        db,
                        ownerId,
                        id.data,
                        body.versionId,
                        true,
                    );
                    validatePrintLayout(version.source, body);
                    const queued = await printRepository.enqueue(db, ownerId, id.data, {
                        versionId: version.id,
                        request: body,
                    });
                    if (queued.conflict)
                        throw new AppError('JOB_IN_PROGRESS', undefined, { jobId: queued.jobId });
                    return { jobId: queued.jobId };
                });
                res.status(202).json({ data: result });
            } catch (error) {
                if (error instanceof JobError)
                    throw new AppError(
                        error.code === 'PRINT_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR',
                        error.message,
                    );
                throw error;
            }
        }),
    );
    return router;
}
