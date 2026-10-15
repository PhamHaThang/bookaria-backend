import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import { IdSchema, PublishBodySchema } from '../../schema';
import { AppError } from '../../utils';
import { publishService } from './publish.service';

export const publishController = {
    publishCheck: async (req: Request<{ bookId: string }>, res: Response) => {
        res.json({
            data: await publishService.publishCheck(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
            ),
        });
    },
    publishBook: async (req: Request<{ bookId: string }>, res: Response) => {
        res.status(202).json({
            data: await publishService.publishBook(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
                PublishBodySchema.parse(req.body),
            ),
        });
    },
    getBookVersions: async (req: Request<{ bookId: string }>, res: Response) => {
        res.json({
            data: await publishService.getBookVersions(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
            ),
        });
    },
    unpublishBook: async (req: Request<{ bookId: string }>, res: Response) => {
        res.json({
            data: await publishService.unpublishBook(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
            ),
        });
    },
};

// --- Helpers ---------------------------------------------------------------------
function bookIdOf(value: string | undefined): string {
    const parsed = IdSchema.safeParse(value);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
    return parsed.data;
}
