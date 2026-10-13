import type { NextFunction, Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import {
    AdminCreateUserBodySchema,
    AdminUpdateUserBodySchema,
    AdminUsersQuerySchema,
    IdSchema,
} from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { adminService } from './admin.service';

export const adminController = {
    authorize: asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
        await adminService.assertAdmin(getAuth(res));
        next();
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
