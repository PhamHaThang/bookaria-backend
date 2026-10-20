import type { NextFunction, Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import {
    AdminBooksQuerySchema,
    AdminCreateUserBodySchema,
    AdminJobsQuerySchema,
    AdminUpdateUserBodySchema,
    AdminUsersQuerySchema,
    AuditLogsQuerySchema,
    CreateBookariaMarkerBodySchema,
    CreateCategoryBodySchema,
    CreateLibraryAssetBodySchema,
    IdSchema,
    LibraryAssetsQuerySchema,
    ModerationNoteBodySchema,
    PaginationQuerySchema,
    TakedownBodySchema,
    UpdateBookariaMarkerBodySchema,
    UpdateCategoryBodySchema,
    UpdateLibraryAssetBodySchema,
} from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { adminService } from './admin.service';

export const adminController = {
    authorize: asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
        await adminService.assertAdmin(getAuth(res));
        next();
    }),

    getDashboard: asyncHandler(async (_req: Request, res: Response) => {
        res.json({ data: await adminService.getDashboard() });
    }),

    getModerationQueue: asyncHandler(async (req: Request, res: Response) => {
        const query = PaginationQuerySchema.parse(req.query);
        const { rows, meta } = await adminService.getModerationQueue(query);
        res.json({ data: rows, meta });
    }),

    getModerationBooks: asyncHandler(async (req: Request, res: Response) => {
        const query = AdminBooksQuerySchema.parse(req.query);
        const { rows, meta } = await adminService.getModerationBooks(query);
        res.json({ data: rows, meta });
    }),

    getModerationBook: asyncHandler(async (req: Request, res: Response) => {
        res.json({ data: await adminService.getModerationBook(bookIdOf(req.params)) });
    }),

    takeDownBook: asyncHandler(async (req: Request, res: Response) => {
        const body = TakedownBodySchema.parse(req.body);
        const result = await adminService.takeDownBook(getAuth(res), bookIdOf(req.params), body);
        res.json({ data: result });
    }),

    reinstateBook: asyncHandler(async (req: Request, res: Response) => {
        const body = ModerationNoteBodySchema.parse(req.body);
        const book = await adminService.reinstateBook(getAuth(res), bookIdOf(req.params), body);
        res.json({ data: { book } });
    }),

    dismissReports: asyncHandler(async (req: Request, res: Response) => {
        const body = ModerationNoteBodySchema.parse(req.body);
        const result = await adminService.dismissReports(getAuth(res), bookIdOf(req.params), body);
        res.json({ data: result });
    }),

    getLibraryAssets: asyncHandler(async (req: Request, res: Response) => {
        const query = LibraryAssetsQuerySchema.parse(req.query);
        const { rows, meta } = await adminService.getLibraryAssets(query);
        res.json({ data: rows, meta });
    }),

    createLibraryAsset: asyncHandler(async (req: Request, res: Response) => {
        const body = CreateLibraryAssetBodySchema.parse(req.body);
        const asset = await adminService.createLibraryAsset(getAuth(res), body);
        res.status(201).json({ data: asset });
    }),

    updateLibraryAsset: asyncHandler(async (req: Request, res: Response) => {
        const body = UpdateLibraryAssetBodySchema.parse(req.body);
        const asset = await adminService.updateLibraryAsset(
            getAuth(res),
            assetIdOf(req.params),
            body,
        );
        res.json({ data: asset });
    }),

    deleteLibraryAsset: asyncHandler(async (req: Request, res: Response) => {
        await adminService.deleteLibraryAsset(getAuth(res), assetIdOf(req.params));
        res.status(204).end();
    }),

    createCategory: asyncHandler(async (req: Request, res: Response) => {
        const body = CreateCategoryBodySchema.parse(req.body);
        const category = await adminService.createCategory(getAuth(res), body);
        res.status(201).json({ data: category });
    }),

    updateCategory: asyncHandler(async (req: Request, res: Response) => {
        const body = UpdateCategoryBodySchema.parse(req.body);
        const category = await adminService.updateCategory(
            getAuth(res),
            categoryIdOf(req.params),
            body,
        );
        res.json({ data: category });
    }),

    deleteCategory: asyncHandler(async (req: Request, res: Response) => {
        await adminService.deleteCategory(getAuth(res), categoryIdOf(req.params));
        res.status(204).end();
    }),

    getBookariaMarkers: asyncHandler(async (req: Request, res: Response) => {
        const query = PaginationQuerySchema.parse(req.query);
        const { rows, meta } = await adminService.getBookariaMarkers(query);
        res.json({ data: rows, meta });
    }),

    createBookariaMarker: asyncHandler(async (req: Request, res: Response) => {
        const body = CreateBookariaMarkerBodySchema.parse(req.body);
        const marker = await adminService.createBookariaMarker(getAuth(res), body);
        res.status(201).json({ data: marker });
    }),

    updateBookariaMarker: asyncHandler(async (req: Request, res: Response) => {
        const body = UpdateBookariaMarkerBodySchema.parse(req.body);
        const marker = await adminService.updateBookariaMarker(
            getAuth(res),
            markerIdOf(req.params),
            body,
        );
        res.json({ data: marker });
    }),

    getJobs: asyncHandler(async (req: Request, res: Response) => {
        const query = AdminJobsQuerySchema.parse(req.query);
        const { rows, meta } = await adminService.getJobs(query);
        res.json({ data: rows, meta });
    }),

    retryJob: asyncHandler(async (req: Request, res: Response) => {
        const jobId = await adminService.retryJob(getAuth(res), jobIdOf(req.params));
        res.status(202).json({ data: { jobId } });
    }),

    getAuditLogs: asyncHandler(async (req: Request, res: Response) => {
        const query = AuditLogsQuerySchema.parse(req.query);
        const { rows, meta } = await adminService.getAuditLogs(query);
        res.json({ data: rows, meta });
    }),

    getAuditLog: asyncHandler(async (req: Request, res: Response) => {
        const log = await adminService.getAuditLog(logIdOf(req.params));
        res.json({ data: log });
    }),

    getUsers: asyncHandler(async (req: Request, res: Response) => {
        const query = AdminUsersQuerySchema.parse(req.query);
        const { rows, meta } = await adminService.getUsers(query);
        res.json({ data: rows, meta });
    }),

    createUser: asyncHandler(async (req: Request, res: Response) => {
        const body = AdminCreateUserBodySchema.parse(req.body);
        const user = await adminService.createUser(getAuth(res), body);
        res.status(201).json({ data: user });
    }),

    getUser: asyncHandler(async (req: Request, res: Response) => {
        const user = await adminService.getUser(userIdOf(req.params));
        res.json({ data: user });
    }),

    updateUser: asyncHandler(async (req: Request, res: Response) => {
        const body = AdminUpdateUserBodySchema.parse(req.body);
        const result = await adminService.updateUser(getAuth(res), userIdOf(req.params), body);
        res.json({ data: result });
    }),
};

function userIdOf(params: { userId?: string }): string {
    const parsed = IdSchema.safeParse(params.userId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy người dùng.');
    return parsed.data;
}

function bookIdOf(params: { bookId?: string }): string {
    const parsed = IdSchema.safeParse(params.bookId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
    return parsed.data;
}

function assetIdOf(params: { assetId?: string }): string {
    const parsed = IdSchema.safeParse(params.assetId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên.');
    return parsed.data;
}

function categoryIdOf(params: { categoryId?: string }): string {
    const parsed = IdSchema.safeParse(params.categoryId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy danh mục.');
    return parsed.data;
}

function markerIdOf(params: { markerId?: string }): string {
    const parsed = IdSchema.safeParse(params.markerId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy marker.');
    return parsed.data;
}

function jobIdOf(params: { jobId?: string }): string {
    const parsed = IdSchema.safeParse(params.jobId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy job.');
    return parsed.data;
}

function logIdOf(params: { logId?: string }): number {
    const num = Number(params.logId);
    if (!Number.isInteger(num) || num <= 0) {
        throw new AppError('NOT_FOUND', 'Không tìm thấy nhật ký quản trị.');
    }
    return num;
}
