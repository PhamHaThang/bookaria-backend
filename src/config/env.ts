import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/bookaria'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    DATABASE_SSL: z.stringbool().default(false),
    JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-32-characters'),
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
    SMTP_URL: z.string().default('smtp://localhost:1025'),
    MAIL_FROM: z.string().default('no-reply@bookaria.local'),
    RUN_WORKER_IN_PROCESS: z.stringbool().default(false),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Biến môi trường không hợp lệ:', parsed.error.format());
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
}
export const env = parsed.data;
export type Env = typeof env;
