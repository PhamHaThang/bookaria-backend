import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import {
    ChangePasswordBodySchema,
    MarkNotificationsReadBodySchema,
    MeUpdateBodySchema,
    NotificationsQuerySchema,
} from '../../schema';
import { asyncHandler } from '../../utils';
import { meService } from './me.service';

export const meController = {
    getMe: asyncHandler(async (_req: Request, res: Response) => {
        const user = await meService.getMe(getAuth(res).userId);
        res.json({ data: user });
    }),
    updateMe: asyncHandler(async (req: Request, res: Response) => {
        const body = MeUpdateBodySchema.parse(req.body);
        const user = await meService.updateMe(getAuth(res).userId, body);
        res.json({ data: user });
    }),
    changePassword: asyncHandler(async (req: Request, res: Response) => {
        const body = ChangePasswordBodySchema.parse(req.body);
        await meService.changePassword(getAuth(res), body);
        res.status(204).end();
    }),
    getNotifications: asyncHandler(async (req: Request, res: Response) => {
        const query = NotificationsQuerySchema.parse(req.query);
        const { data, meta } = await meService.getNotifications(getAuth(res).userId, query);
        res.json({ data, meta });
    }),
    markNotificationsAsRead: asyncHandler(async (req: Request, res: Response) => {
        const body = MarkNotificationsReadBodySchema.parse(req.body);
        await meService.markNotificationsAsRead(getAuth(res).userId, body);
        res.status(204).end();
    }),
};
