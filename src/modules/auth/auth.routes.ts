import { Router } from 'express';
import {
    getAuth,
    rateLimitMiddleware,
    requireAuth,
    requireTrustedOrigin,
    validateMiddleware,
} from '../../middlewares';
import {
    ForgotPasswordBodySchema,
    LoginBodySchema,
    RegisterBodySchema,
    ResetPasswordBodySchema,
    VerifyEmailBodySchema,
} from '../../schema';
import { HOUR, MINUTE } from './auth.constants';
import { authController } from './auth.controller';

export const authRouter = (options: { rateLimit: boolean }) => {
    const router = Router();
    const enabled = options.rateLimit;

    const loginLimit = rateLimitMiddleware({
        windowMs: MINUTE,
        limit: 5,
        enabled,
        skipSuccessfulRequests: true,
    });
    const registerLimit = rateLimitMiddleware({
        windowMs: HOUR,
        limit: 5,
        enabled,
    });
    const forgotLimit = rateLimitMiddleware({
        windowMs: HOUR,
        limit: 5,
        enabled,
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
    router.post(
        '/register',
        registerLimit,
        validateMiddleware({
            body: RegisterBodySchema,
        }),
        authController.register,
    );

    // [POST] /auth/login
    router.post(
        '/login',
        loginLimit,
        validateMiddleware({
            body: LoginBodySchema,
        }),
        authController.login,
    );

    // [POST] /auth/refresh
    router.post('/refresh', refreshLimit, requireTrustedOrigin, authController.refresh);

    // [POST] /auth/logout (dựa vào cookie refresh, không cần access token còn hạn)
    router.post('/logout', requireTrustedOrigin, authController.logout);

    // [POST] /auth/verify-email
    router.post(
        '/verify-email',
        tokenLimit,
        validateMiddleware({
            body: VerifyEmailBodySchema,
        }),
        authController.verifyEmail,
    );

    // [POST] /auth/resend-verification
    router.post('/resend-verification', requireAuth, resendLimit, authController.resendVerifyEmail);

    // [POST] /auth/forgot-password
    router.post(
        '/forgot-password',
        forgotLimit,
        validateMiddleware({
            body: ForgotPasswordBodySchema,
        }),
        authController.forgotPassword,
    );

    // [POST] /auth/reset-password
    router.post(
        '/reset-password',
        tokenLimit,
        validateMiddleware({
            body: ResetPasswordBodySchema,
        }),
        authController.resetPassword,
    );

    return router;
};
