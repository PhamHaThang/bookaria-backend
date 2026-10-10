import { z } from 'zod';
import { IdSchema, LIMITS } from '../common.schema';
import { UserRoleSchema } from '../enums.schema';

export const EmailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'Email không hợp lệ' }));

const utf8 = new TextEncoder();

export const NewPasswordSchema = z
    .string()
    .min(LIMITS.passwordMinLength, {
        error: `Mật khẩu tối thiểu ${LIMITS.passwordMinLength} ký tự`,
    })
    .refine((password) => utf8.encode(password).length <= LIMITS.passwordMaxLength, {
        error: `Mật khẩu quá dài (tối đa ${LIMITS.passwordMaxLength} byte, ký tự có dấu chiếm nhiều byte hơn)`,
    });

export const RegisterBodySchema = z.object({
    displayName: z
        .string()
        .trim()
        .min(1, { error: 'Vui lòng nhập họ tên' })
        .max(100, { error: 'Họ tên tối đa 100 ký tự' }),
    email: EmailSchema,
    password: NewPasswordSchema,
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
    email: EmailSchema,
    password: z
        .string()
        .min(1, { error: 'Vui lòng nhập mật khẩu' })
        .max(LIMITS.passwordMaxLength, {
            error: `Mật khẩu tối đa ${LIMITS.passwordMaxLength} ký tự`,
        }),
    remember: z.boolean().default(false),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const GoogleLoginBodySchema = z.object({
    idToken: z.string().min(1),
});
export type GoogleLoginBody = z.infer<typeof GoogleLoginBodySchema>;
export const VerifyEmailBodySchema = z.object({
    token: z.string().min(1).max(200),
});
export type VerifyEmailBody = z.infer<typeof VerifyEmailBodySchema>;
export const ForgotPasswordBodySchema = z.object({
    email: EmailSchema,
});
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;
export const ResetPasswordBodySchema = z.object({
    token: z.string().min(1).max(200),
    newPassword: NewPasswordSchema,
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;

export const AuthUserSchema = z.object({
    id: IdSchema,
    email: z.email(),
    displayName: z.string(),
    role: UserRoleSchema,
    emailVerified: z.boolean(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthResponseSchema = z.object({
    accessToken: z.string(),
    expiresIn: z.int().positive(),
    user: AuthUserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const RefreshTokenResultSchema = z.object({
    accessToken: z.string(),
    expiresIn: z.int().positive(),
});
export type RefreshTokenResult = z.infer<typeof RefreshTokenResultSchema>;
