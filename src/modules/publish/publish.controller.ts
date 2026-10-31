import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import { IdSchema, ListBookVersionsQuerySchema, PublishBodySchema } from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { publishService } from './publish.service';

export const publishController = {
    getShareInfo: asyncHandler(async (req: Request, res: Response) => {
        res.json({
            data: await publishService.getShareInfo(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
            ),
        });
    }),
    publishCheck: asyncHandler(async (req: Request, res: Response) => {
        res.json({
            data: await publishService.publishCheck(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
            ),
        });
    }),
    publishBook: asyncHandler(async (req: Request, res: Response) => {
        res.status(202).json({
            data: await publishService.publishBook(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
                PublishBodySchema.parse(req.body),
            ),
        });
    }),
    getBookVersions: asyncHandler(async (req: Request, res: Response) => {
        res.json({
            data: await publishService.getBookVersions(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
                ListBookVersionsQuerySchema.parse(req.query),
            ),
        });
    }),
    unpublishBook: asyncHandler(async (req: Request, res: Response) => {
        res.json({
            data: await publishService.unpublishBook(
                getAuth(res).userId,
                bookIdOf(req.params.bookId),
            ),
        });
    }),
};

// --- Helpers ---------------------------------------------------------------------
function bookIdOf(value: string | string[] | undefined): string {
    const parsed = IdSchema.safeParse(value);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
    return parsed.data;
}
