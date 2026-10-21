import { Router } from 'express';
import { getAuth, rateLimitMiddleware, requireAuth, requireTrustedOrigin } from '../../middlewares';
import { LoginBodySchema } from '../../schema';
import { HOUR, MINUTE } from './auth.constants';
import { authController } from './auth.controller';

export const authRouter = (options: { rateLimit: boolean }) => {
    const router = Router();
    const enabled = options.rateLimit;

    const loginIpLimit = rateLimitMiddleware({
        windowMs: MINUTE,
        limit: 10,
        enabled,
        skipSuccessfulRequests: true,
    });
    const loginEmailLimit = rateLimitMiddleware({
        windowMs: 15 * MINUTE,
        limit: 10,
        enabled,
        key: (req) => {
            const email = (req.body as { email?: unknown } | undefined)?.email;
            return typeof email === 'string'
                ? `login_email:${email.trim().toLowerCase()}`
                : `ip:${req.ip ?? ''}`;
        },
        skipSuccessfulRequests: true,
    });
    const registerLimit = rateLimitMiddleware({
        windowMs: HOUR,
        limit: 5,
        enabled,
    });
    const forgotLimit = rateLimitMiddleware({
        windowMs: HOUR,
        limit: 3,
        enabled,
        key: (req) => {
            const email = (req.body as { email?: unknown } | undefined)?.email;
            return typeof email === 'string'
                ? `forgot_email:${email.trim().toLowerCase()}`
                : `ip:${req.ip ?? ''}`;
        },
    });
    const refreshLimit = rateLimitMiddleware({
        windowMs: MINUTE,
        limit: 30,
        enabled,
    });
    // verify-email và reset-password: token 256 bit không đoán được, giới hạn chỉ để chặn lạm dụng.
    const tokenLimit = rateLimitMiddleware({
        windowMs: HOUR,
        limit: 20,
        enabled,
    });
    const resendLimit = rateLimitMiddleware({
        windowMs: HOUR,
        limit: 3,
        enabled,
        key: (_req, res) => `resend:${getAuth(res).userId}`,
    });

    // [POST] /auth/register
    router.post('/register', registerLimit, authController.register);

    // [POST] /auth/login
    router.post(
        '/login',
        loginIpLimit,
        (req, _res, next) => {
            // Malformed requests consume the IP quota, not another user's email quota.
            LoginBodySchema.parse(req.body);
            next();
        },
        loginEmailLimit,
        authController.login,
    );

    // [POST] /auth/google
    router.post('/google', loginIpLimit, authController.googleLogin);

    // [POST] /auth/refresh
    router.post('/refresh', refreshLimit, requireTrustedOrigin, authController.refresh);

    // [POST] /auth/logout (dựa vào cookie refresh, không cần access token còn hạn)
    router.post('/logout', requireTrustedOrigin, authController.logout);

    // [POST] /auth/verify-email
    router.post('/verify-email', tokenLimit, authController.verifyEmail);

    // [POST] /auth/resend-verification
    router.post('/resend-verification', requireAuth, resendLimit, authController.resendVerifyEmail);

    // [POST] /auth/forgot-password
    router.post('/forgot-password', forgotLimit, authController.forgotPassword);

    // [POST] /auth/reset-password
    router.post('/reset-password', tokenLimit, authController.resetPassword);

    return router;
};
