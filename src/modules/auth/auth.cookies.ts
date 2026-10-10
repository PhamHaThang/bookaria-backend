import type { CookieOptions, Response } from 'express';
import { env } from '../../config';
import { REFRESH_TOKEN_COOKIE_NAME } from './auth.constants';

const base: CookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: '/api/v1/auth',
};

export function setRefreshCookie(res: Response, token: string, maxAgeMs?: number) {
    res.cookie(
        REFRESH_TOKEN_COOKIE_NAME,
        token,
        maxAgeMs === undefined ? base : { ...base, maxAge: maxAgeMs },
    );
}

export function clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, base);
}
