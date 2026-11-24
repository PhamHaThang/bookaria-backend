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
        SEED_ADMIN_PASSWORD: z.preprocess(
            (value) => (value === '' ? undefined : value),
            z.string().min(8).max(72).optional(),
        ),
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
        PUBLIC_API_URL: HttpUrlSchema.default('https://viewer.localhost:5174'),
        GOOGLE_CLIENT_ID: z.string().default(''),
        AI_BASE_URL: z
            .url()
            .default('https://api.openai.com/v1')
            .refine((value) => {
                const url = new URL(value);
                return (
                    !url.username &&
                    !url.password &&
                    !url.search &&
                    !url.hash &&
                    (url.protocol === 'https:' ||
                        (url.protocol === 'http:' &&
                            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
                );
            }, 'AI_BASE_URL cần HTTPS hoặc HTTP localhost.'),
        AI_API_KEY: z.string().default(''),
        RUNPOD_MODEL_API_KEY: z.string().trim().default(''),
        RUNPOD_MODEL_ENDPOINT_ID: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_-]*$/)
            .default(''),
        AI_MODEL: z.string().trim().max(200).default(''),
        AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(40000),
        ZEROTTS_URL: z
            .union([
                z.literal(''),
                z.url().refine((value) => {
                    const url = new URL(value);
                    return (
                        !url.username &&
                        !url.password &&
                        !url.search &&
                        !url.hash &&
                        (url.protocol === 'https:' || url.protocol === 'http:')
                    );
                }),
            ])
            .default(''),
        ZEROTTS_API_KEY: z.string().default(''),
        ZEROTTS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(180000),
        R2_ENDPOINT: z.union([z.literal(''), z.url({ protocol: /^https$/ })]).default(''),
        R2_ACCESS_KEY_ID: z.string().default(''),
        R2_SECRET_ACCESS_KEY: z.string().default(''),
        R2_BUCKET: z.string().default(''),
        R2_PUBLIC_URL: z.union([z.literal(''), z.url({ protocol: /^https$/ })]).default(''),
        FFMPEG_PATH: z.string().default(''),
        FFPROBE_PATH: z.string().default(''),
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
