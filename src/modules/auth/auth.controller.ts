import type { Request, Response } from 'express';
import { getAuth, type ValidatedRequest } from '../../middlewares';
import {
    type ForgotPasswordBody,
    type LoginBody,
    RefreshTokenResultSchema,
    type RegisterBody,
    type ResetPasswordBody,
    type VerifyEmailBody,
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
    register: asyncHandler(async (req: ValidatedRequest<RegisterBody>, res: Response) => {
        const data = await authService.register(req.body, { userAgent: req.get('user-agent') });
        respondWithAuthResult(res, 201, data);
    }),

    login: asyncHandler(async (req: ValidatedRequest<LoginBody>, res: Response) => {
        const data = await authService.login(req.body, { userAgent: req.get('user-agent') });
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
    verifyEmail: asyncHandler(async (req: ValidatedRequest<VerifyEmailBody>, res: Response) => {
        await authService.verifyEmail(req.body.token);
        res.json({ data: { emailVerified: true } });
    }),
    resendVerifyEmail: asyncHandler(async (_req: Request, res: Response) => {
        await authService.resendVerifyEmail(getAuth(res).userId);
        res.status(204).end();
    }),
    forgotPassword: asyncHandler(
        async (req: ValidatedRequest<ForgotPasswordBody>, res: Response) => {
            await authService.forgotPassword(req.body.email);
            res.json({ data: { sent: true } });
        },
    ),
    resetPassword: asyncHandler(async (req: ValidatedRequest<ResetPasswordBody>, res: Response) => {
        await authService.resetPassword(req.body.token, req.body.newPassword);
        res.json({ data: { reset: true } });
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
