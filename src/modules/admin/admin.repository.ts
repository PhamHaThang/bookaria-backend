import type { Queryable } from '../../db';
import type {
    AdminBooksQuery,
    AdminUsersQuery,
    AuditAction,
    AuditTargetType,
    UserRole,
    UserStatus,
} from '../../schema';
import type {
    AdminBookRow,
    AdminDashboardMetricsRow,
    AdminUserRow,
    AuditActionTodayRow,
    CurrentAdminRow,
    LockedModerationBookRow,
    LockedUserRow,
    ModerationBookRow,
    ModerationPageRow,
    ModerationQueueRow,
    ModerationReportRow,
    PublishedPerDayRow,
} from './admin.types';

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

const MODERATION_BOOK_COLUMNS = `b.id, b.title, b.description,
    cover.thumbnail_url AS cover_url, b.status, b.visibility,
    (b.taken_down_at IS NOT NULL) AS taken_down, b.taken_down_reason,
    (SELECT count(*)::int FROM pages p WHERE p.book_id = b.id) AS page_count,
    (SELECT count(*)::int FROM reports r
     WHERE r.book_id = b.id AND r.status = 'OPEN') AS report_count,
    b.updated_at, u.id AS author_id, u.display_name AS author_display_name`;

const MODERATION_BOOK_JOINS = `JOIN users u ON u.id = b.owner_id
    LEFT JOIN assets cover ON cover.id = b.cover_asset_id`;

export const adminRepository = {
    async getDashboard(db: Queryable) {
        const [metrics, publishedPerDay, auditActionsToday] = await Promise.all([
            db.query<AdminDashboardMetricsRow>(
                `SELECT
                    (SELECT count(*)::int FROM users) AS users,
                    (SELECT count(*)::int FROM books
                     WHERE first_published_at IS NOT NULL AND deleted_at IS NULL) AS published_books,
                    (SELECT coalesce(sum(storage_used_bytes), 0)::text FROM users) AS storage_used_bytes,
                    (SELECT count(*)::int FROM jobs
                     WHERE status = 'FAILED'
                       AND coalesce(finished_at, created_at) >= now() - interval '24 hours') AS failed_jobs_24h,
                    (SELECT count(*)::int FROM reports WHERE status = 'OPEN') AS open_reports`,
            ),
            db.query<PublishedPerDayRow>(
                `WITH days AS (
                    SELECT generate_series(
                        (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 6,
                        (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
                        interval '1 day'
                    )::date AS date
                )
                SELECT days.date::text AS date, count(books.id)::int AS count
                FROM days
                LEFT JOIN books
                  ON (books.first_published_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = days.date
                 AND books.deleted_at IS NULL
                GROUP BY days.date
                ORDER BY days.date`,
            ),
            db.query<AuditActionTodayRow>(
                `SELECT action, count(*)::int AS count
                 FROM audit_logs
                 WHERE (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date =
                       (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
                 GROUP BY action
                 ORDER BY count DESC, action`,
            ),
        ]);

        return {
            metrics: metrics.rows[0] as AdminDashboardMetricsRow,
            publishedPerDay: publishedPerDay.rows,
            auditActionsToday: auditActionsToday.rows,
        };
    },

    async getModerationQueue(db: Queryable, limit: number, offset: number) {
        const { rows } = await db.query<ModerationQueueRow>(
            `SELECT b.id AS book_id, b.title AS book_title,
                    u.id AS author_id, u.display_name AS author_display_name,
                    count(r.id)::int AS report_count,
                    array_agg(DISTINCT r.reason::text) AS reasons,
                    max(r.created_at) AS last_reported_at
             FROM reports r
             JOIN books b ON b.id = r.book_id AND b.deleted_at IS NULL
             JOIN users u ON u.id = b.owner_id
             WHERE r.status = 'OPEN'
             GROUP BY b.id, b.title, u.id, u.display_name
             ORDER BY last_reported_at DESC, b.id
             LIMIT $1 OFFSET $2`,
            [limit, offset],
        );
        const count = await db.query<{ total: number }>(
            `SELECT count(DISTINCT r.book_id)::int AS total
             FROM reports r
             JOIN books b ON b.id = r.book_id AND b.deleted_at IS NULL
             WHERE r.status = 'OPEN'`,
        );
        return { rows, total: count.rows[0]?.total ?? 0 };
    },

    async getModerationBooks(db: Queryable, query: AdminBooksQuery, offset: number) {
        const where = [`b.deleted_at IS NULL`, `b.visibility = $1`];
        const params: unknown[] = [query.visibility];
        if (query.q) {
            params.push(`%${escapeLike(query.q)}%`);
            where.push(
                `(b.title ILIKE $${params.length} ESCAPE '\\' OR u.display_name ILIKE $${params.length} ESCAPE '\\' OR u.email ILIKE $${params.length} ESCAPE '\\')`,
            );
        }
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const { rows } = await db.query<ModerationBookRow>(
            `SELECT ${MODERATION_BOOK_COLUMNS}
             FROM books b ${MODERATION_BOOK_JOINS}
             ${whereSql}
             ORDER BY b.updated_at DESC, b.id
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, query.limit, offset],
        );
        const count = await db.query<{ total: number }>(
            `SELECT count(*)::int AS total
             FROM books b ${MODERATION_BOOK_JOINS} ${whereSql}`,
            params,
        );
        return { rows, total: count.rows[0]?.total ?? 0 };
    },

    async findModerationBook(
        db: Queryable,
        bookId: string,
    ): Promise<ModerationBookRow | undefined> {
        const { rows } = await db.query<ModerationBookRow>(
            `SELECT ${MODERATION_BOOK_COLUMNS}
             FROM books b ${MODERATION_BOOK_JOINS}
             WHERE b.id = $1 AND b.deleted_at IS NULL`,
            [bookId],
        );
        return rows[0];
    },

    async getModerationPages(db: Queryable, bookId: string): Promise<ModerationPageRow[]> {
        const { rows } = await db.query<ModerationPageRow>(
            `SELECT p.id, p.order_index, p.title, image.thumbnail_url,
                    p.marker_mode, marker.number AS marker_number, p.marker_score,
                    jsonb_array_length(coalesce(p.scene->'objects', '[]'::jsonb))::int AS object_count
             FROM pages p
             JOIN assets image ON image.id = p.image_asset_id
             LEFT JOIN bookaria_markers marker ON marker.id = p.bookaria_marker_id
             WHERE p.book_id = $1
             ORDER BY p.order_index, p.id`,
            [bookId],
        );
        return rows;
    },

    async getBookReports(db: Queryable, bookId: string): Promise<ModerationReportRow[]> {
        const { rows } = await db.query<ModerationReportRow>(
            `SELECT id, reason, note, status, created_at, handled_at
             FROM reports WHERE book_id = $1 ORDER BY created_at DESC, id`,
            [bookId],
        );
        return rows;
    },

    async lockModerationBook(
        db: Queryable,
        bookId: string,
    ): Promise<LockedModerationBookRow | undefined> {
        const { rows } = await db.query<LockedModerationBookRow>(
            `SELECT b.id, b.owner_id, b.title, b.visibility, b.visibility_before_lock,
                    b.taken_down_at, u.status AS owner_status
             FROM books b JOIN users u ON u.id = b.owner_id
             WHERE b.id = $1 AND b.deleted_at IS NULL
             FOR UPDATE OF b`,
            [bookId],
        );
        return rows[0];
    },

    async takeDownBook(db: Queryable, bookId: string, reason: string): Promise<void> {
        await db.query(
            `UPDATE books
             SET visibility_before_lock = coalesce(visibility_before_lock, visibility),
                 visibility = 'PRIVATE', taken_down_at = now(), taken_down_reason = $2
             WHERE id = $1`,
            [bookId, reason],
        );
    },

    async handleOpenReports(
        db: Queryable,
        bookId: string,
        actorId: string,
        status: 'ACTIONED' | 'DISMISSED',
        note: string | null,
    ): Promise<number> {
        const result = await db.query(
            `UPDATE reports
             SET status = $3, handled_by = $2, handled_at = now(), resolution_note = $4
             WHERE book_id = $1 AND status = 'OPEN'`,
            [bookId, actorId, status, note],
        );
        return result.rowCount ?? 0;
    },

    async reinstateBook(
        db: Queryable,
        bookId: string,
        visibility: LockedModerationBookRow['visibility'],
        clearPreviousVisibility: boolean,
    ): Promise<void> {
        await db.query(
            `UPDATE books
             SET visibility = $2, taken_down_at = NULL, taken_down_reason = NULL,
                 visibility_before_lock = CASE WHEN $3 THEN NULL ELSE visibility_before_lock END
             WHERE id = $1`,
            [bookId, visibility, clearPreviousVisibility],
        );
    },

    async insertBookNotification(
        db: Queryable,
        userId: string,
        bookId: string,
        notification: {
            type: 'BOOK_TAKEN_DOWN' | 'BOOK_REINSTATED';
            title: string;
            body: string;
        },
    ): Promise<void> {
        await db.query(
            `INSERT INTO notifications (user_id, type, title, body, link)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, notification.type, notification.title, notification.body, `/books/${bookId}`],
        );
    },

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
        targetType: AuditTargetType = 'USER',
    ): Promise<void> {
        await db.query(
            `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail)
             VALUES ($1, $2, $3, $4, $5)`,
            [actorId, action, targetType, targetId, detail],
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
