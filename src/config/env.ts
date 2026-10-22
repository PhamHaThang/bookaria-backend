import { z } from 'zod';
import { HttpUrlSchema } from '../schema/common.schema';

const DEV_JWT_SECRET = 'dev-only-secret-change-me-32-characters';

const envSchema = z
    .object({
        NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
        PORT: z.coerce.number().default(4000),
        DATABASE_URL: z.string().default('postgresql://bookaria:bookaria@localhost:5432/bookaria'),
        DATABASE_SSL: z.stringbool().default(false),
        JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
        CORS_ORIGINS: z
            .string()
            .default('http://localhost:5173,https://localhost:5174,https://viewer.localhost:5174'),
        SMTP_URL: z
            .string()
            .regex(/^(smtps?:\/\/.+)?$/, {
                error: 'SMTP_URL phải bắt đầu bằng smtp:// hoặc smtps://',
            })
            .default(''),
        MAIL_FROM: z.string().min(3).default('Bookaria <no-reply@bookaria.local>'),
        RUN_WORKER_IN_PROCESS: z.stringbool().default(false),
        // Chỉ dùng cho `pnpm db:seed`.
        SEED_ADMIN_EMAIL: z.email().default('admin@gmail.com'),
        SEED_ADMIN_PASSWORD: z.string().min(8).max(72).optional(),
        BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(31).default(12),
        /** Cookie chứa refresh token. SameSite=None (cần khi Studio và API khác site) bắt buộc phải có Secure. */
        COOKIE_SECURE: z.stringbool().optional(),
        COOKIE_SAMESITE: z.enum(['none', 'lax', 'strict']).default('lax'),
        RATE_LIMIT_ENABLED: z.stringbool().default(true),
        /** Số reverse proxy đứng trước API (Render = 1). */
        TRUST_PROXY: z.coerce.number().int().min(0).default(0),
        ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
        REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(604800),
        STUDIO_URL: z.url().default('http://localhost:5173'),
        VIEWER_URL: HttpUrlSchema.default('https://viewer.localhost:5174'),
        PUBLIC_API_URL: HttpUrlSchema.default('http://api.localhost:4000'),
        GOOGLE_CLIENT_ID: z.string().default(''),
        CLOUDINARY_URL: z
            .string()
            .trim()
            .regex(/^(cloudinary:\/\/[^:@\s]+:[^@\s]+@[^\s/]+)?$/, {
                error: 'CLOUDINARY_URL phải có dạng cloudinary://<api_key>:<api_secret>@<cloud_name>',
            })
            .default(''),
    })
    .transform((env) => ({
        ...env,
        COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    }))
    .refine((env) => env.COOKIE_SAMESITE !== 'none' || env.COOKIE_SECURE, {
        path: ['COOKIE_SECURE'],
        error: 'COOKIE_SAMESITE=none bắt buộc phải có COOKIE_SECURE=true',
    })
    .refine((env) => env.NODE_ENV !== 'production' || env.SMTP_URL !== '', {
        path: ['SMTP_URL'],
        error: 'Production cần SMTP_URL, nếu không sẽ không có email nào (xác minh, đặt lại mật khẩu) được gửi',
    })
    .refine((env) => env.NODE_ENV !== 'production' || env.JWT_SECRET !== DEV_JWT_SECRET, {
        path: ['JWT_SECRET'],
        error: 'Production cần JWT_SECRET khác giá trị mặc định (32 ký tự)',
    });
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Biến môi trường không hợp lệ:', parsed.error.format());
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
}
export const env = parsed.data;
export type Env = typeof env;
