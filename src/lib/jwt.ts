import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config';
import { IdSchema, UserRoleSchema } from '../schema';
import { AppError } from '../utils';

const ClaimsSchema = z.object({
    sub: IdSchema,
    role: UserRoleSchema,
    sid: IdSchema,
});
export type AccessTokenClaims = z.infer<typeof ClaimsSchema>;

export function signAccessToken(claims: AccessTokenClaims): string {
    return jwt.sign({ role: claims.role, sid: claims.sid }, env.JWT_SECRET, {
        subject: claims.sub,
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
        algorithm: 'HS256',
    });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
    try {
        const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
        return ClaimsSchema.parse(payload);
    } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
            throw new AppError('TOKEN_EXPIRED', 'Phiên đăng nhập đã hết hạn.');
        }
        throw new AppError('UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục.');
    }
}
