import type { Queryable } from '../../db';
import type { MeRow, NotificationRow } from './me.types';

const ME_COLUMNS = `id, email, display_name, avatar_url, organization, bio, role, email_verified_at,
  storage_used_bytes, storage_quota_bytes, created_at`;

export const meRepository = {
    // --- User Profile -------------------------------------------------------------------------------
    async findMe(db: Queryable, userId: string): Promise<MeRow | undefined> {
        const { rows } = await db.query<MeRow>(`SELECT ${ME_COLUMNS} FROM users WHERE id = $1`, [
            userId,
        ]);
        return rows[0];
    },
    async updateMe(
        db: Queryable,
        userId: string,
        changes: Record<string, string | null>,
    ): Promise<MeRow | undefined> {
        const columns = Object.keys(changes);
        if (columns.length === 0) return meRepository.findMe(db, userId);
        const assignments = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
        const { rows } = await db.query<MeRow>(
            `UPDATE users SET ${assignments} WHERE id = $1 RETURNING ${ME_COLUMNS}`,
            [userId, ...columns.map((column) => changes[column])],
        );
        return rows[0];
    },
    // --- Notifications -------------------------------------------------------------------------------
    async getNotifications(
        db: Queryable,
        userId: string,
        opts: {
            unreadOnly: boolean;
            limit: number;
            offset: number;
        },
    ): Promise<{ rows: NotificationRow[]; total: number }> {
        const whereClause = `user_id = $1 ${opts.unreadOnly ? ' AND read_at IS NULL' : ''}`;
        const { rows } = await db.query<NotificationRow>(
            `SELECT id, type, title, body, link, read_at, created_at FROM notifications
            WHERE ${whereClause} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [userId, opts.limit, opts.offset],
        );
        const count = await db.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM notifications WHERE ${whereClause}`,
            [userId],
        );
        return { rows, total: count.rows[0]?.n ?? 0 };
    },
    /** Marks the user's own unread notifications as read. `notificationIds` undefined = all of them. */
    async markNotificationsAsRead(
        db: Queryable,
        userId: string,
        notificationIds?: string[],
    ): Promise<void> {
        if (notificationIds) {
            await db.query(
                `UPDATE notifications SET read_at = NOW()
                WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
                [userId, notificationIds],
            );
        } else {
            await db.query(
                `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
                [userId],
            );
        }
    },
};
