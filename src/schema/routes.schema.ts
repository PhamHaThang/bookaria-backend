import { z } from 'zod';
import {
    AuthResponseSchema,
    ForgotPasswordBodySchema,
    LoginBodySchema,
    RefreshTokenResultSchema,
    RegisterBodySchema,
    ResetPasswordBodySchema,
    VerifyEmailBodySchema,
} from './api/auth.schema';
import { dataResponse } from './common.schema';
import type { ErrorCode } from './error.schema';

export type Access = 'public' | 'cookie' | 'author' | 'admin';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
    id: string; // stable operation id, e.g. "postBooks"
    method: HttpMethod;
    path: string; // after /api/v1, with :param placeholders
    access: Access;
    summary: string;
    detailed?: boolean;
    params?: z.ZodObject;
    query?: z.ZodObject;
    body?: z.ZodType;
    responses: Record<number, z.ZodType | null>; // null = no body
    errors?: ErrorCode[]; // route-specific error codes
}

/**
 * List of all API routes, for generating OpenAPI spec and route docs.
 */
export const routes: Route[] = [
    {
        id: 'postAuthRegister',
        method: 'POST',
        path: '/auth/register',
        access: 'public',
        summary: 'Đăng ký tài khoản mới với email và mật khẩu và gửi email xác thực',
        detailed: true,
        body: RegisterBodySchema,
        responses: {
            201: dataResponse(AuthResponseSchema),
        },
        errors: ['EMAIL_TAKEN'],
    },
    {
        id: 'postAuthVerifyEmail',
        method: 'POST',
        path: '/auth/verify-email',
        access: 'public',
        summary: 'Xác thực email của người dùng bằng mã trong link',
        body: VerifyEmailBodySchema,
        responses: {
            200: dataResponse(z.object({ emailVerified: z.literal(true) })),
        },
        errors: ['TOKEN_INVALID'],
    },
    {
        id: 'postAuthResendVerification',
        method: 'POST',
        path: '/auth/resend-verification',
        access: 'author',
        summary: 'Gửi lại email xác thực cho người dùng',
        responses: {
            204: null,
        },
    },
    {
        id: 'postAuthLogin',
        method: 'POST',
        path: '/auth/login',
        access: 'public',
        summary: 'Đăng nhập vào tài khoản với email và mật khẩu',
        detailed: true,
        body: LoginBodySchema,
        responses: {
            200: dataResponse(AuthResponseSchema),
        },
        errors: ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED'],
    },
    {
        id: 'postAuthRefresh',
        method: 'POST',
        path: '/auth/refresh',
        access: 'cookie',
        summary: 'Cấp lại access token mới bằng refresh token trong cookie',
        detailed: true,
        responses: {
            200: dataResponse(RefreshTokenResultSchema),
        },
        errors: ['UNAUTHENTICATED', 'ACCOUNT_LOCKED'],
    },
    {
        id: 'postAuthLogout',
        method: 'POST',
        path: '/auth/logout',
        access: 'cookie',
        summary: 'Đăng xuất khỏi tài khoản và thu hồi phiên làm việc hiện tại (refresh token)',
        responses: {
            204: null,
        },
    },
    {
        id: 'postAuthForgotPassword',
        method: 'POST',
        path: '/auth/forgot-password',
        access: 'public',
        summary: 'Gửi email đặt lại mật khẩu cho người dùng',
        body: ForgotPasswordBodySchema,
        responses: { 200: dataResponse(z.object({ sent: z.literal(true) })) },
    },
    {
        id: 'postAuthResetPassword',
        method: 'POST',
        path: '/auth/reset-password',
        access: 'public',
        summary: 'Đặt mật khẩu mới bằng mã',
        body: ResetPasswordBodySchema,
        responses: { 200: dataResponse(z.object({ reset: z.literal(true) })) },
        errors: ['TOKEN_INVALID'],
    },
];
