import type { Queryable } from '../../db';
import type { AuthSessionRow, AuthTokenType, UserRow } from './auth.types';

const USER_COLUMNS = `id, email, password_hash, display_name, role, status, email_verified_at,
  failed_login_count, locked_until`;

export const authRepository = {
    // --- Users ---------------------------------------------------------------------
    async findUserByEmail(db: Queryable, email: string): Promise<UserRow | null> {
        const { rows } = await db.query<UserRow>(
            `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
            [email],
        );
        return rows[0] ?? null;
    },

    async findUserById(db: Queryable, id: string): Promise<UserRow | null> {
        const { rows } = await db.query<UserRow>(
            `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
            [id],
        );
        return rows[0] ?? null;
    },

    async insertUser(
        db: Queryable,
        user: { email: string; passwordHash: string | null; displayName: string },
    ): Promise<UserRow> {
        const { rows } = await db.query<UserRow>(
            `INSERT INTO users (email, password_hash, display_name)
             VALUES ($1, $2, $3)
             RETURNING ${USER_COLUMNS}`,
            [user.email, user.passwordHash, user.displayName],
        );
        return rows[0] as UserRow;
    },

    async recordFailedLogin(
        db: Queryable,
        userId: string,
        maxFailures: number,
        lockMinutes: number,
    ): Promise<{ failed_login_count: number; locked_until: Date | null }> {
        const { rows } = await db.query<{ failed_login_count: number; locked_until: Date | null }>(
            `UPDATE users SET
                failed_login_count = CASE
                    WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                    ELSE failed_login_count + 1 END,
                locked_until = CASE
                    WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                               ELSE failed_login_count + 1 END) >= $2
                    THEN now() + make_interval(mins => $3)
                    ELSE NULL END
             WHERE id = $1
             RETURNING failed_login_count, locked_until`,
            [userId, maxFailures, lockMinutes],
        );
        return rows[0] as { failed_login_count: number; locked_until: Date | null };
    },

    async recordSuccessfulLogin(db: Queryable, userId: string): Promise<void> {
        await db.query(
            `UPDATE users
                SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
              WHERE id = $1`,
            [userId],
        );
    },

    async updateUserEmailVerifiedAt(db: Queryable, userId: string): Promise<void> {
        await db.query(
            `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
            [userId],
        );
    },

    async updateUserPassword(db: Queryable, userId: string, passwordHash: string): Promise<void> {
        await db.query(
            `UPDATE users
                SET password_hash = $2, failed_login_count = 0, locked_until = NULL
              WHERE id = $1`,
            [userId, passwordHash],
        );
    },

    // --- Auth sessions ---------------------------------------------------------------------
    async insertAuthSession(
        db: Queryable,
        s: {
            userId: string;
            refreshTokenHash: string;
            remember: boolean;
            userAgent: string | undefined;
            ttlSeconds: number;
        },
    ): Promise<AuthSessionRow> {
        const { rows } = await db.query<AuthSessionRow>(
            `INSERT INTO auth_sessions
                 (user_id, refresh_token_hash, remember, user_agent, expires_at)
             VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
             RETURNING *`,
            [s.userId, s.refreshTokenHash, s.remember, s.userAgent ?? null, s.ttlSeconds],
        );
        return rows[0] as AuthSessionRow;
    },

    async findAuthSessionByRefreshTokenHash(
        db: Queryable,
        refreshTokenHash: string,
    ): Promise<AuthSessionRow | null> {
        const { rows } = await db.query<AuthSessionRow>(
            `SELECT * FROM auth_sessions WHERE refresh_token_hash = $1`,
            [refreshTokenHash],
        );
        return rows[0] ?? null;
    },

    async findAuthSessionByPreviousTokenHash(
        db: Queryable,
        tokenHash: string,
    ): Promise<AuthSessionRow | null> {
        const { rows } = await db.query<AuthSessionRow>(
            `SELECT * FROM auth_sessions WHERE previous_token_hash = $1`,
            [tokenHash],
        );
        return rows[0] ?? null;
    },

    async rotateAuthSessionRefreshToken(
        db: Queryable,
        authSessionId: string,
        oldRefreshTokenHash: string,
        newRefreshTokenHash: string,
    ): Promise<boolean> {
        const result = await db.query(
            `UPDATE auth_sessions
                SET previous_token_hash = $2, refresh_token_hash = $3, last_used_at = now()
              WHERE id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL
          RETURNING id`,
            [authSessionId, oldRefreshTokenHash, newRefreshTokenHash],
        );
        return result.rowCount === 1;
    },

    async revokeAuthSession(db: Queryable, authSessionId: string): Promise<void> {
        await db.query(
            `UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
            [authSessionId],
        );
    },

    async revokeAuthSessionByTokenHash(db: Queryable, tokenHash: string): Promise<void> {
        await db.query(
            `UPDATE auth_sessions SET revoked_at = now()
              WHERE (refresh_token_hash = $1 OR previous_token_hash = $1) AND revoked_at IS NULL`,
            [tokenHash],
        );
    },

    async revokeAllAuthSessionsForUser(db: Queryable, userId: string): Promise<void> {
        await db.query(
            `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId],
        );
    },

    // --- Auth tokens (link trong email) ---------------------------------------------------
    async insertAuthToken(
        db: Queryable,
        t: { userId: string; type: AuthTokenType; tokenHash: string; ttlMinutes: number },
    ): Promise<void> {
        await db.query(
            `INSERT INTO auth_tokens (user_id, type, token_hash, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
            [t.userId, t.type, t.tokenHash, t.ttlMinutes],
        );
    },

    /** Vô hiệu hoá các token chưa dùng của người dùng (khi phát hành token mới). */
    async cancelUnusedAuthTokens(
        db: Queryable,
        userId: string,
        type: AuthTokenType,
    ): Promise<void> {
        await db.query(
            `UPDATE auth_tokens SET used_at = now()
              WHERE user_id = $1 AND type = $2 AND used_at IS NULL`,
            [userId, type],
        );
    },

    /** Kiểm tra token còn dùng được hay không? */
    async isAuthTokenValid(
        db: Queryable,
        type: AuthTokenType,
        tokenHash: string,
    ): Promise<boolean> {
        const { rows } = await db.query(
            `SELECT 1 FROM auth_tokens
              WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now()`,
            [tokenHash, type],
        );
        return rows.length > 0;
    },

    /** Đánh dấu token đã dùng và trả về id người dùng; `undefined` nếu sai, hết hạn hoặc đã dùng. */
    async consumeAuthToken(
        db: Queryable,
        type: AuthTokenType,
        tokenHash: string,
    ): Promise<string | undefined> {
        const { rows } = await db.query<{ user_id: string }>(
            `UPDATE auth_tokens SET used_at = now()
              WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
            [tokenHash, type],
        );
        return rows[0]?.user_id;
    },

    /** Số giây kể từ lần phát hành token gần nhất (đã dùng hay chưa); `null` nếu chưa có. */
    async secondsSinceLastAuthToken(
        db: Queryable,
        userId: string,
        type: AuthTokenType,
    ): Promise<number | null> {
        const { rows } = await db.query<{ seconds: number | null }>(
            `SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))::float8 AS seconds
               FROM auth_tokens WHERE user_id = $1 AND type = $2`,
            [userId, type],
        );
        return rows[0]?.seconds ?? null;
    },

    async countTokensLastHour(db: Queryable, userId: string, type: AuthTokenType): Promise<number> {
        const { rows } = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM auth_tokens
              WHERE user_id = $1 AND type = $2 AND created_at > now() - interval '1 hour'`,
            [userId, type],
        );
        return rows[0]?.count ?? 0;
    },
};
