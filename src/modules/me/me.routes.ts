import { Router } from 'express';
import { getAuth, rateLimitMiddleware, requireAuth } from '../../middlewares';
import { meController } from './me.controller';

const HOUR = 60 * 60_000;

export const meRouter = (options: { rateLimit: boolean }) => {
    const router = Router();
    router.use(requireAuth);
    const passwordLimit = rateLimitMiddleware({
        windowMs: HOUR,
        limit: 5,
        enabled: options.rateLimit,
        key: (_req, res) => `password:${getAuth(res).userId}`,
    });
    // [GET] /me
    router.get('/', meController.getMe);
    // [PATCH] /me
    router.patch('/', meController.updateMe);
    // [PUT] /me/password
    router.put('/password', passwordLimit, meController.changePassword);
    // [GET] /me/notifications
    router.get('/notifications', meController.getNotifications);
    // [POST] /me/notifications/read
    router.post('/notifications/read', meController.markNotificationsAsRead);

    return router;
};
