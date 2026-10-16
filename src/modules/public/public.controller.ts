import type { Request, Response } from 'express';
import { IdSchema, PublicBooksQuerySchema, ReportBookBodySchema } from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { publicService } from './public.service';

export const publicController = {
    getPublicBooks: asyncHandler(async (req: Request, res: Response) => {
        const q = PublicBooksQuerySchema.parse(req.query);
        const result = await publicService.getPublicBooks(q);
        res.json(result);
    }),

    getAuthorProfile: asyncHandler(async (req: Request, res: Response) => {
        const authorId = IdSchema.safeParse(req.params.authorId);
        if (!authorId.success) throw new AppError('NOT_FOUND', 'Không tìm thấy tác giả');
        const result = await publicService.getAuthorProfile(authorId.data);
        res.json({
            data: result,
        });
    }),

    getPublicBook: asyncHandler(async (req: Request, res: Response) => {
        const data = await publicService.getPublicBookBySlug(slugParam(req));
        res.set('Cache-Control', 'public, max-age=60').json({ data }); // cache 1 phút
    }),

    recordViewEvents: asyncHandler(async (req: Request, res: Response) => {
        await publicService.recordViewEvents(req.body);
        res.status(202).end();
    }),

    reportBook: asyncHandler(async (req: Request, res: Response) => {
        const body = ReportBookBodySchema.parse(req.body);
        await publicService.reportBook(slugParam(req), body);
        res.status(201).json({ data: { received: true } });
    }),
};

// --- Helpers --------------------------------------
function slugParam(req: Request): string {
    const slug = req.params.slug;
    if (typeof slug !== 'string') throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
    return slug;
}
