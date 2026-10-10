import { env, logger } from '../../config';
import { pool, withTransaction } from '../../db';
import {
    getMailer,
    hashPassword,
    type Mail,
    signAccessToken,
    spendPasswordCheckTime,
    verifyPassword,
} from '../../lib';
import type { AuthUser, LoginBody, RegisterBody } from '../../schema';
import { AppError, hashToken, newToken } from '../../utils';
import {
    LOCK_MINUTES,
    MAX_FAILED_LOGINS,
    REFRESH_GRACE_SECONDS,
    RESEND_COOLDOWN_SECONDS,
    RESET_MAILS_PER_HOUR,
    RESET_PASSWORD_TTL_MINUTES,
    VERIFY_EMAIL_TTL_HOURS,
} from './auth.constants';
import { resetPasswordMail, verifyEmailMail } from './auth.emails';
import { authRepository } from './auth.repository';
import type { AuthResult, AuthSessionRow, UserRow } from './auth.types';

export const authService = {
    async register(
        body: RegisterBody,
        ctx: { userAgent: string | undefined },
    ): Promise<AuthResult> {
        if (await authRepository.findUserByEmail(pool, body.email))
            throw new AppError('EMAIL_TAKEN', 'Email đã được sử dụng');

        const passwordHash = await hashPassword(body.password);
        const verifyToken = newToken();
        const refreshToken = newToken();

        let user: UserRow;
        let session: AuthSessionRow;
        try {
            ({ user, session } = await withTransaction(async (client) => {
                const user = await authRepository.insertUser(client, {
                    email: body.email,
                    passwordHash,
                    displayName: body.displayName,
                });
                await authRepository.insertAuthToken(client, {
                    userId: user.id,
                    type: 'VERIFY_EMAIL',
                    tokenHash: hashToken(verifyToken),
                    ttlMinutes: VERIFY_EMAIL_TTL_HOURS * 60,
                });
                const session = await authRepository.insertAuthSession(client, {
                    userId: user.id,
                    refreshTokenHash: hashToken(refreshToken),
                    remember: false,
                    userAgent: ctx.userAgent,
                    ttlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
                });
                return { user, session };
            }));
        } catch (error) {
            if (isUniqueViolation(error))
                throw new AppError('EMAIL_TAKEN', 'Email đã được sử dụng');
            throw error;
        }

        await sendMailSafely(verifyEmailMail(user.email, user.display_name, verifyToken));
        return toAuthResponse(user, session, refreshToken);
    },

    async verifyEmail(token: string): Promise<void> {
        await withTransaction(async (client) => {
            const userId = await authRepository.consumeAuthToken(
                client,
                'VERIFY_EMAIL',
                hashToken(token),
            );
            if (!userId) throw tokenInvalidError();
            await authRepository.updateUserEmailVerifiedAt(client, userId);
        });
    },

    async resendVerifyEmail(userId: string): Promise<void> {
        const user = await authRepository.findUserById(pool, userId);
        if (!user) throw unauthenticatedError();

        if (user.email_verified_at) return;
        const sinceLast = await authRepository.secondsSinceLastAuthToken(
            pool,
            userId,
            'VERIFY_EMAIL',
        );
        if (sinceLast !== null && sinceLast < RESEND_COOLDOWN_SECONDS)
            throw new AppError('RATE_LIMITED', 'Vui lòng đợi trước khi gửi lại email xác thực', {
                // Làm tròn lên: hợp đồng quy định số nguyên giây (RateLimitedDetailsSchema).
                retryAfterSeconds: Math.max(1, Math.ceil(RESEND_COOLDOWN_SECONDS - sinceLast)),
            });

        const verifyToken = newToken();
        await withTransaction(async (client) => {
            await authRepository.cancelUnusedAuthTokens(client, userId, 'VERIFY_EMAIL');
            await authRepository.insertAuthToken(client, {
                userId,
                type: 'VERIFY_EMAIL',
                tokenHash: hashToken(verifyToken),
                ttlMinutes: VERIFY_EMAIL_TTL_HOURS * 60,
            });
        });
        await sendMailSafely(verifyEmailMail(user.email, user.display_name, verifyToken));
    },

    async login(body: LoginBody, ctx: { userAgent: string | undefined }): Promise<AuthResult> {
        const user = await authRepository.findUserByEmail(pool, body.email);
        if (!user?.password_hash) {
            await spendPasswordCheckTime(body.password);
            throw invalidCredentialsError();
        }
        if (user.status === 'LOCKED') throw lockedAccountError();

        if (user.locked_until && user.locked_until > new Date()) {
            throw temporarilyLockedError(user.locked_until);
        }

        if (!(await verifyPassword(body.password, user.password_hash))) {
            const result = await authRepository.recordFailedLogin(
                pool,
                user.id,
                MAX_FAILED_LOGINS,
                LOCK_MINUTES,
            );
            if (result.locked_until) throw temporarilyLockedError(result.locked_until);
            throw invalidCredentialsError();
        }
        await authRepository.recordSuccessfulLogin(pool, user.id);

        const refreshToken = newToken();
        const session = await authRepository.insertAuthSession(pool, {
            userId: user.id,
            refreshTokenHash: hashToken(refreshToken),
            remember: body.remember,
            userAgent: ctx.userAgent,
            ttlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
        });
        return toAuthResponse(user, session, refreshToken);
    },

    async refreshToken(refreshToken: string | undefined): Promise<AuthResult> {
        if (!refreshToken) throw unauthenticatedError();
        const refreshTokenHash = hashToken(refreshToken);
        const session = await authRepository.findAuthSessionByRefreshTokenHash(
            pool,
            refreshTokenHash,
        );
        if (session) {
            if (session.revoked_at || session.expires_at < new Date()) throw unauthenticatedError();
            const user = await authRepository.findUserById(pool, session.user_id);
            if (!user) throw unauthenticatedError();
            if (user.status === 'LOCKED') {
                await authRepository.revokeAuthSession(pool, session.id);
                throw lockedAccountError();
            }

            const newRefreshToken = newToken();
            if (
                await authRepository.rotateAuthSessionRefreshToken(
                    pool,
                    session.id,
                    refreshTokenHash,
                    hashToken(newRefreshToken),
                )
            )
                return toAuthResponse(user, session, newRefreshToken);
        }
        const replacedSession = await authRepository.findAuthSessionByPreviousTokenHash(
            pool,
            refreshTokenHash,
        );
        if (
            replacedSession &&
            !replacedSession.revoked_at &&
            replacedSession.expires_at > new Date()
        ) {
            const sinceLastUsed = Date.now() - (replacedSession.last_used_at?.getTime() ?? 0);
            if (sinceLastUsed < REFRESH_GRACE_SECONDS * 1000) {
                const user = await authRepository.findUserById(pool, replacedSession.user_id);
                if (!user) throw unauthenticatedError();
                return toAuthResponse(user, replacedSession);
            }
            await authRepository.revokeAuthSession(pool, replacedSession.id);
            logger.warn(
                { sessionId: replacedSession.id, userId: replacedSession.user_id },
                'refresh token reuse: session revoked',
            );
        }
        throw unauthenticatedError();
    },
    async logout(refreshToken: string | undefined): Promise<void> {
        if (!refreshToken) return;
        await authRepository.revokeAuthSessionByTokenHash(pool, hashToken(refreshToken));
    },
    /**
     * Luôn trả về ngay. Việc tra email, tạo token và gửi thư chạy nền để thời gian phản hồi không cho biết email có tồn tại hay không.
     */
    async forgotPassword(email: string): Promise<void> {
        void sendResetPasswordMail(email).catch((err) =>
            logger.error({ err }, 'forgot-password failed'),
        );
    },

    async resetPassword(token: string, newPassword: string): Promise<void> {
        const tokenHash = hashToken(token);
        if (!(await authRepository.isAuthTokenValid(pool, 'RESET_PASSWORD', tokenHash))) {
            throw tokenInvalidError();
        }
        const passwordHash = await hashPassword(newPassword);
        await withTransaction(async (client) => {
            const userId = await authRepository.consumeAuthToken(
                client,
                'RESET_PASSWORD',
                tokenHash,
            );
            if (!userId) throw tokenInvalidError();
            await authRepository.updateUserPassword(client, userId, passwordHash);
            await authRepository.revokeAllAuthSessionsForUser(client, userId);
            await authRepository.cancelUnusedAuthTokens(client, userId, 'RESET_PASSWORD');
        });
    },
};

// --- Helpers ---------------------------------------------------------------------
async function sendMailSafely(mail: Mail): Promise<void> {
    try {
        await getMailer().send(mail);
    } catch (error) {
        logger.error({ err: error, to: mail.to }, 'sending email failed');
    }
}
function isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string }).code === '23505';
}

function toAuthResponse(user: UserRow, session: AuthSessionRow, refreshToken?: string): AuthResult {
    return {
        accessToken: signAccessToken({ sub: user.id, role: user.role, sid: session.id }),
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
        user: toAuthUser(user),
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(session.remember ? { cookieMaxAgeMs: session.expires_at.getTime() - Date.now() } : {}),
    };
}

function toAuthUser(user: UserRow): AuthUser {
    return {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        emailVerified: !!user.email_verified_at,
    };
}

function unauthenticatedError(): AppError {
    return new AppError('UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục');
}
function tokenInvalidError(): AppError {
    return new AppError('TOKEN_INVALID', 'Liên kết không đúng, đã hết hạn hoặc đã được dùng.');
}
function invalidCredentialsError(): AppError {
    return new AppError('INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
}
function temporarilyLockedError(until: Date): AppError {
    return new AppError(
        'ACCOUNT_LOCKED',
        'Tài khoản tạm thời bị khóa do đăng nhập sai nhiều lần. Vui lòng thử lại sau.',
        { lockedUntil: until.toISOString() },
    );
}
async function sendResetPasswordMail(email: string): Promise<void> {
    const user = await authRepository.findUserByEmail(pool, email);
    if (!user) return;
    const sent = await authRepository.countTokensLastHour(pool, user.id, 'RESET_PASSWORD');
    if (sent >= RESET_MAILS_PER_HOUR) return;

    const token = newToken();
    await withTransaction(async (client) => {
        await authRepository.cancelUnusedAuthTokens(client, user.id, 'RESET_PASSWORD');
        await authRepository.insertAuthToken(client, {
            userId: user.id,
            type: 'RESET_PASSWORD',
            tokenHash: hashToken(token),
            ttlMinutes: RESET_PASSWORD_TTL_MINUTES,
        });
    });
    await sendMailSafely(resetPasswordMail(user.email, user.display_name, token));
}
function lockedAccountError(): AppError {
    return new AppError('ACCOUNT_LOCKED', 'Tài khoản đã bị khoá, vui lòng liên hệ quản trị viên.', {
        byAdmin: true,
    });
}
