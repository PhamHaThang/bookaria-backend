import type { Request, Response } from 'express';
import { IdSchema, PublicBooksQuerySchema, ReportBookBodySchema } from '../../schema';
import { AppError } from '../../utils';
import { publicService } from './public.service';

export const publicController = {
    getPublicBooks: async (req: Request, res: Response) => {
        const q = PublicBooksQuerySchema.parse(req.query);
        const result = await publicService.getPublicBooks(q);
        res.json(result);
    },

    getAuthorProfile: async (req: Request, res: Response) => {
        const authorId = IdSchema.safeParse(req.params.authorId);
        if (!authorId.success) throw new AppError('NOT_FOUND', 'Không tìm thấy tác giả');
        const result = await publicService.getAuthorProfile(authorId.data);
        res.json({
            data: result,
        });
    },

    getPublicBook: async (req: Request<{ slug: string }>, res: Response) => {
        const data = await publicService.getPublicBookBySlug(req.params.slug);
        res.set('Cache-Control', 'public, max-age=60').json({ data }); // cache 1 phút
    },

    recordViewEvents: async (req: Request, res: Response) => {
        await publicService.recordViewEvents(req.body);
        res.status(202).end();
    },

    reportBook: async (req: Request<{ slug: string }>, res: Response) => {
        const body = ReportBookBodySchema.parse(req.body);
        await publicService.reportBook(req.params.slug, body);
        res.status(201).json({ data: { received: true } });
    },
};
