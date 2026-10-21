import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import {
    ForgotPasswordBodySchema,
    GoogleLoginBodySchema,
    LoginBodySchema,
    RefreshTokenResultSchema,
    RegisterBodySchema,
    ResetPasswordBodySchema,
    VerifyEmailBodySchema,
} from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { REFRESH_TOKEN_COOKIE_NAME } from './auth.constants';
import { clearRefreshCookie, setRefreshCookie } from './auth.cookies';
import { authService } from './auth.service';
import type { AuthResult } from './auth.types';

const COOKIE_CLEARING_CODES = new Set<string>([
    'UNAUTHENTICATED',
    'TOKEN_INVALID',
    'TOKEN_EXPIRED',
    'ACCOUNT_LOCKED',
]);

export const authController = {
    register: asyncHandler(async (req: Request, res: Response) => {
        const body = RegisterBodySchema.parse(req.body);
        const data = await authService.register(body, { userAgent: req.get('user-agent') });
        respondWithAuthResult(res, 201, data);
    }),

    login: asyncHandler(async (req: Request, res: Response) => {
        const body = LoginBodySchema.parse(req.body);
        const data = await authService.login(body, { userAgent: req.get('user-agent') });
        respondWithAuthResult(res, 200, data);
    }),
    googleLogin: asyncHandler(async (req: Request, res: Response) => {
        const { idToken } = GoogleLoginBodySchema.parse(req.body);
        const data = await authService.loginWithGoogle(idToken, {
            userAgent: req.get('user-agent'),
        });
        respondWithAuthResult(res, 200, data);
    }),
    refresh: asyncHandler(async (req: Request, res: Response) => {
        try {
            const data = await authService.refreshToken(req.cookies?.[REFRESH_TOKEN_COOKIE_NAME]);

            if (data.refreshToken) setRefreshCookie(res, data.refreshToken, data.cookieMaxAgeMs);
            res.status(200).json({
                data: RefreshTokenResultSchema.parse({
                    accessToken: data.accessToken,
                    expiresIn: data.expiresIn,
                }),
            });
        } catch (error) {
            if (error instanceof AppError && COOKIE_CLEARING_CODES.has(error.code)) {
                clearRefreshCookie(res);
            }
            throw error;
        }
    }),
    logout: asyncHandler(async (req: Request, res: Response) => {
        await authService.logout(req.cookies?.[REFRESH_TOKEN_COOKIE_NAME]);
        clearRefreshCookie(res);
        res.status(204).end();
    }),
    verifyEmail: asyncHandler(async (req: Request, res: Response) => {
        const { token } = VerifyEmailBodySchema.parse(req.body);
        await authService.verifyEmail(token);
        res.json({ data: { emailVerified: true } });
    }),
    resendVerifyEmail: asyncHandler(async (_req: Request, res: Response) => {
        await authService.resendVerifyEmail(getAuth(res).userId);
        res.status(204).end();
    }),
    forgotPassword: asyncHandler(async (req: Request, res: Response) => {
        const { email } = ForgotPasswordBodySchema.parse(req.body);
        await authService.forgotPassword(email);
        res.json({ data: { sent: true } });
    }),
    resetPassword: asyncHandler(async (req: Request, res: Response) => {
        const { token, newPassword } = ResetPasswordBodySchema.parse(req.body);
        await authService.resetPassword(token, newPassword);
        res.status(204).end();
    }),
};
function respondWithAuthResult(res: Response, status: number, authResult: AuthResult) {
    if (authResult.refreshToken)
        setRefreshCookie(res, authResult.refreshToken, authResult.cookieMaxAgeMs);
    res.status(status).json({
        data: {
            accessToken: authResult.accessToken,
            expiresIn: authResult.expiresIn,
            user: authResult.user,
        },
    });
}
