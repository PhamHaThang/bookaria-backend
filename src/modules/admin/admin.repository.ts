import type { Queryable } from '../../db';
import type { AdminUsersQuery, AuditAction, UserRole, UserStatus } from '../../schema';
import type { AdminBookRow, AdminUserRow, CurrentAdminRow, LockedUserRow } from './admin.types';

const USER_COLUMNS = `u.id, u.email, u.display_name, u.avatar_url, u.organization, u.bio,
    u.role, u.status, u.email_verified_at, u.storage_used_bytes, u.storage_quota_bytes,
    u.last_login_at, u.created_at, u.updated_at,
    (SELECT count(*)::int FROM books b WHERE b.owner_id = u.id AND b.deleted_at IS NULL) AS book_count`;

const SORT_COLUMNS = {
    displayName: 'u.display_name',
    email: 'u.email',
    createdAt: 'u.created_at',
    updatedAt: 'u.updated_at',
    storageUsedBytes: 'u.storage_used_bytes',
} as const;

export const adminRepository = {
    async findCurrentAdmin(
        db: Queryable,
        userId: string,
        sessionId: string,
    ): Promise<CurrentAdminRow | undefined> {
        const { rows } = await db.query<CurrentAdminRow>(
            `SELECT u.role, u.status, EXISTS (
                SELECT 1 FROM auth_sessions s
                WHERE s.id = $2 AND s.user_id = u.id AND s.revoked_at IS NULL
                  AND s.expires_at > now()
            ) AS session_active
            FROM users u WHERE u.id = $1`,
            [userId, sessionId],
        );
        return rows[0];
    },

    async getUsers(
        db: Queryable,
        query: AdminUsersQuery,
        offset: number,
    ): Promise<{ rows: AdminUserRow[]; total: number }> {
        const where: string[] = [];
        const params: unknown[] = [];
        if (query.q) {
            params.push(`%${escapeLike(query.q)}%`);
            where.push(
                `(u.email ILIKE $${params.length} ESCAPE '\\' OR u.display_name ILIKE $${params.length} ESCAPE '\\')`,
            );
        }
        if (query.role) {
            params.push(query.role);
            where.push(`u.role = $${params.length}`);
        }
        if (query.status) {
            params.push(query.status);
            where.push(`u.status = $${params.length}`);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const { rows } = await db.query<AdminUserRow>(
            `SELECT ${USER_COLUMNS}
             FROM users u ${whereSql}
             ORDER BY ${orderBy(query.sort)}, u.id
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, query.limit, offset],
        );
        const count = await db.query<{ total: number }>(
            `SELECT count(*)::int AS total FROM users u ${whereSql}`,
            params,
        );
        return { rows, total: count.rows[0]?.total ?? 0 };
    },

    async insertUser(
        db: Queryable,
        user: {
            email: string;
            passwordHash: string;
            displayName: string;
            role: UserRole;
            storageQuotaBytes: number;
        },
    ): Promise<string> {
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO users
                (email, password_hash, display_name, role, storage_quota_bytes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [user.email, user.passwordHash, user.displayName, user.role, user.storageQuotaBytes],
        );
        return (rows[0] as { id: string }).id;
    },

    async findUser(db: Queryable, userId: string): Promise<AdminUserRow | undefined> {
        const { rows } = await db.query<AdminUserRow>(
            `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`,
            [userId],
        );
        return rows[0];
    },

    async getUserBooks(db: Queryable, userId: string): Promise<AdminBookRow[]> {
        const { rows } = await db.query<AdminBookRow>(
            `SELECT b.id, b.title, b.status, b.visibility,
                    (b.taken_down_at IS NOT NULL) AS taken_down,
                    (SELECT count(*)::int FROM pages p WHERE p.book_id = b.id) AS page_count,
                    b.updated_at
             FROM books b
             WHERE b.owner_id = $1 AND b.deleted_at IS NULL
             ORDER BY b.updated_at DESC, b.id`,
            [userId],
        );
        return rows;
    },

    async lockUser(db: Queryable, userId: string): Promise<LockedUserRow | undefined> {
        const { rows } = await db.query<LockedUserRow>(
            `SELECT id, display_name, role, status, storage_quota_bytes
             FROM users WHERE id = $1 FOR UPDATE`,
            [userId],
        );
        return rows[0];
    },

    async updateUser(
        db: Queryable,
        userId: string,
        changes: {
            status?: UserStatus | undefined;
            role?: UserRole | undefined;
            storageQuotaBytes?: number | undefined;
        },
    ): Promise<LockedUserRow> {
        const { rows } = await db.query<LockedUserRow>(
            `UPDATE users SET
                status = COALESCE($2::user_status, status),
                role = COALESCE($3::user_role, role),
                storage_quota_bytes = COALESCE($4::bigint, storage_quota_bytes)
             WHERE id = $1
             RETURNING id, display_name, role, status, storage_quota_bytes`,
            [
                userId,
                changes.status ?? null,
                changes.role ?? null,
                changes.storageQuotaBytes ?? null,
            ],
        );
        return rows[0] as LockedUserRow;
    },

    async revokeUserSessions(db: Queryable, userId: string): Promise<void> {
        await db.query(
            `UPDATE auth_sessions SET revoked_at = now()
             WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId],
        );
    },

    async hideUserBooks(db: Queryable, userId: string): Promise<void> {
        await db.query(
            `UPDATE books
             SET visibility_before_lock = COALESCE(visibility_before_lock, visibility),
                 visibility = 'PRIVATE'
             WHERE owner_id = $1`,
            [userId],
        );
    },

    async restoreUserBooks(db: Queryable, userId: string): Promise<void> {
        await db.query(
            `UPDATE books
             SET visibility = CASE
                     WHEN taken_down_at IS NULL THEN COALESCE(visibility_before_lock, visibility)
                     ELSE visibility
                 END,
                 visibility_before_lock = CASE
                     WHEN taken_down_at IS NULL THEN NULL
                     ELSE visibility_before_lock
                 END
             WHERE owner_id = $1 AND visibility_before_lock IS NOT NULL`,
            [userId],
        );
    },

    async insertNotification(
        db: Queryable,
        userId: string,
        notification: { type: 'ACCOUNT_LOCKED' | 'ACCOUNT_UNLOCKED'; title: string; body: string },
    ): Promise<void> {
        await db.query(
            `INSERT INTO notifications (user_id, type, title, body, link)
             VALUES ($1, $2, $3, $4, '/me')`,
            [userId, notification.type, notification.title, notification.body],
        );
    },

    async insertAuditLog(
        db: Queryable,
        actorId: string,
        action: AuditAction,
        targetId: string,
        detail: Record<string, unknown>,
    ): Promise<void> {
        await db.query(
            `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail)
             VALUES ($1, $2, 'USER', $3, $4)`,
            [actorId, action, targetId, detail],
        );
    },
};

function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function orderBy(sort: AdminUsersQuery['sort']): string {
    const descending = sort.startsWith('-');
    const key = (descending ? sort.slice(1) : sort) as keyof typeof SORT_COLUMNS;
    return `${SORT_COLUMNS[key]} ${descending ? 'DESC' : 'ASC'}`;
}
