import { type Request, type Response, Router } from 'express';
import { withTransaction } from '../../db';
import { getAuth, rateLimitMiddleware, requireAuth } from '../../middlewares';
import { IdSchema, PrintPdfBodySchema } from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { validatePrintLayout } from '../../worker/print/layout';
import { JobError } from '../jobs/jobs.types';
import { printRepository, readPrintVersion } from './print.repository';

export function printRouter(enabled: boolean) {
    const router = Router({ mergeParams: true });
    router.use(requireAuth);
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
                    const version = await readPrintVersion(db, ownerId, id.data, undefined, true);
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
