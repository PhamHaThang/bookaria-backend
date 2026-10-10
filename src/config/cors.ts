import { env } from './env';

export const corsOrigins: string[] = env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
