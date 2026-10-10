import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyAccessToken } from '../lib';
import type { UserRole } from '../schema';
import { AppError } from '../utils';

export interface Auth {
    userId: string;
    role: UserRole;
    sessionId: string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    const header = req.get('Authorization');
    if (!header?.startsWith('Bearer ')) {
        throw new AppError('UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục');
    }
    const claims = verifyAccessToken(header.slice('Bearer '.length));
    res.locals.auth = {
        userId: claims.sub,
        role: claims.role,
        sessionId: claims.sid,
    } satisfies Auth;
    next();
}
export function requireRole(...role: UserRole[]): RequestHandler {
    return (_req: Request, res: Response, next: NextFunction) => {
        const userRole = getAuth(res).role;
        if (!role.includes(userRole)) {
            throw new AppError('FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này.');
        }
        next();
    };
}

export function getAuth(res: Response): Auth {
    const auth = res.locals.auth as Auth | undefined;
    if (!auth) throw new AppError('UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục');
    return auth;
}
