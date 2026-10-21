import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { pool } from '../db';
import { verifyAccessToken } from '../lib';
import type { UserRole } from '../schema';
import { AppError, asyncHandler, lockedByAdminError } from '../utils';

export interface Auth {
    userId: string;
    role: UserRole;
    sessionId: string;
}

export const requireAuth = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('Authorization');
    if (!header?.startsWith('Bearer ')) {
        throw new AppError('UNAUTHENTICATED');
    }
    const claims = verifyAccessToken(header.slice('Bearer '.length));
    const { rows } = await pool.query<{
        id: string;
        role: UserRole;
        status: string;
        session_active: boolean;
    }>(
        'SELECT u.id, u.role, u.status, EXISTS(SELECT 1 FROM auth_sessions s WHERE s.id=$2 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) AS session_active FROM users u WHERE u.id=$1',
        [claims.sub, claims.sid],
    );
    const user = rows[0];
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (user.status !== 'ACTIVE') throw lockedByAdminError();
    if (!user.session_active) throw new AppError('UNAUTHENTICATED');

    res.locals.auth = {
        userId: user.id,
        role: user.role,
        sessionId: claims.sid,
    } satisfies Auth;
    next();
});

export function requireRole(...role: UserRole[]): RequestHandler {
    return (_req: Request, res: Response, next: NextFunction) => {
        const userRole = getAuth(res).role;
        if (!role.includes(userRole)) {
            throw new AppError('FORBIDDEN');
        }
        next();
    };
}

export function getAuth(res: Response): Auth {
    const auth = res.locals.auth as Auth | undefined;
    if (!auth) throw new AppError('UNAUTHENTICATED');
    return auth;
}
