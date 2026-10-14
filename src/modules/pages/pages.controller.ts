import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import {
    AddPageBodySchema,
    IdSchema,
    ReorderPagesBodySchema,
    ReplacePageImageBodySchema,
    SaveSceneBodySchema,
    UpdateMarkerBodySchema,
    UpdatePageBodySchema,
} from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { pagesService } from './pages.service';

export const pagesController = {
    getBookPages: asyncHandler(async (req: Request, res: Response) => {
        const bookId = idOf(req.params.bookId, 'sách');
        const pages = await pagesService.getPages(getAuth(res).userId, bookId);
        res.json({
            data: pages,
        });
    }),
    addPage: asyncHandler(async (req: Request, res: Response) => {
        const bookId = idOf(req.params.bookId, 'sách');
        const body = AddPageBodySchema.parse(req.body);
        const page = await pagesService.addPage(getAuth(res).userId, bookId, body);
        res.status(201).json({
            data: page,
        });
    }),
    reorderPages: asyncHandler(async (req: Request, res: Response) => {
        const bookId = idOf(req.params.bookId, 'sách');
        const body = ReorderPagesBodySchema.parse(req.body);
        const pages = await pagesService.reorderPages(getAuth(res).userId, bookId, body);
        res.json({
            data: pages,
        });
    }),
    getPage: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const page = await pagesService.getPage(getAuth(res).userId, pageId);
        res.json({
            data: page,
        });
    }),
    updatePage: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const body = UpdatePageBodySchema.parse(req.body);
        const page = await pagesService.updatePage(getAuth(res).userId, pageId, body);
        res.json({
            data: page,
        });
    }),
    replacePageImage: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const body = ReplacePageImageBodySchema.parse(req.body);
        const page = await pagesService.replacePageImage(getAuth(res).userId, pageId, body);
        res.json({
            data: page,
        });
    }),
    duplicatePage: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const page = await pagesService.duplicatePage(getAuth(res).userId, pageId);
        res.status(201).json({
            data: page,
        });
    }),
    deletePage: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        await pagesService.deletePage(getAuth(res).userId, pageId);
        res.status(204).end();
    }),

    // --- Marker ---
    getPageMarker: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const marker = await pagesService.getPageMarker(getAuth(res).userId, pageId);
        res.json({
            data: marker,
        });
    }),
    updatePageMarker: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const body = UpdateMarkerBodySchema.parse(req.body);
        const result = await pagesService.updatePageMarker(getAuth(res).userId, pageId, body);
        res.status(result.status).json({
            data: result.data,
        });
    }),
    rescorePageMarker: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const result = await pagesService.rescoreMarker(getAuth(res).userId, pageId);
        res.status(202).json({ data: result });
    }),
    saveScene: asyncHandler(async (req: Request, res: Response) => {
        const pageId = idOf(req.params.pageId, 'trang');
        const body = SaveSceneBodySchema.parse(req.body);
        const result = await pagesService.saveScene(getAuth(res).userId, pageId, body);
        res.json({
            data: result,
        });
    }),
};

// --- Helpers ---
function idOf(value: unknown, what: string): string {
    const parsed = IdSchema.safeParse(value);
    if (!parsed.success) throw new AppError('NOT_FOUND', `Không tìm thấy ${what}.`);
    return parsed.data;
}
