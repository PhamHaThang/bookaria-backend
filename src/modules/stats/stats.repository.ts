import type { Queryable } from '../../db';
import type { PageStatsRow, TotalStatsRow } from './stats.types';

export const statsRepository = {
    // Kiểm tra xem một cuốn sách có thuộc sở hữu của người dùng hay không
    async isBookOwnedByUser(db: Queryable, ownerId: string, bookId: string): Promise<boolean> {
        const { rows } = await db.query(
            `SELECT 1 FROM books WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
            [bookId, ownerId],
        );
        return rows.length > 0;
    },

    // Lấy tổng số thống kê cho một cuốn sách kể từ một thời điểm nhất định: số lần mở, số phiên, số lần chạm, số lần quét hết thời gian
    async getTotalStats(
        db: Queryable,
        bookId: string,
        since: Date,
        until: Date,
    ): Promise<TotalStatsRow> {
        const { rows } = await db.query<TotalStatsRow>(
            `SELECT
                COUNT(*) FILTER (WHERE event = 'OPEN')::int AS opens,
                count(DISTINCT session_id)::int AS sessions,
                COUNT(*) FILTER (WHERE event = 'TAP')::int AS taps,
                COUNT(*) FILTER (WHERE event = 'SCAN_TIMEOUT')::int AS scan_timeouts
            FROM view_events
            WHERE book_id = $1 AND created_at >= $2 AND created_at < $3`,
            [bookId, since, until],
        );
        return rows[0] as TotalStatsRow;
    },

    // Lấy số lần mở hàng ngày cho một cuốn sách kể từ một thời điểm nhất định
    async getDailyOpens(
        db: Queryable,
        bookId: string,
        since: Date,
        until: Date,
    ): Promise<{ day: string; opens: number }[]> {
        const { rows } = await db.query<{ day: string; opens: number }>(
            `SELECT
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS opens
            FROM view_events
            WHERE book_id = $1 AND created_at >= $2 AND created_at < $3 AND event = 'OPEN'
            GROUP BY 1`,
            [bookId, since, until],
        );
        return rows;
    },

    async getPageStats(
        db: Queryable,
        bookId: string,
        since: Date,
        until: Date,
    ): Promise<PageStatsRow[]> {
        const { rows } = await db.query<PageStatsRow>(
            `SELECT
                p.id as page_id,
                (row_number() OVER (ORDER BY p.order_index))::int AS page_number,
                p.title as title,
                COUNT(ve.id) FILTER (WHERE ve.event = 'PAGE_FOUND')::int AS found,
                COUNT(ve.id) FILTER (WHERE ve.event = 'TAP')::int AS taps
            FROM pages p
            LEFT JOIN view_events ve ON p.id = ve.page_id AND ve.book_id = $1 AND ve.created_at >= $2 AND ve.created_at < $3
            WHERE p.book_id = $1
            GROUP BY p.id, p.order_index, p.title
            ORDER BY p.order_index`,
            [bookId, since, until],
        );
        return rows;
    },

    async getDeviceStats(
        db: Queryable,
        bookId: string,
        since: Date,
        until: Date,
    ): Promise<{ type: string; os: string; count: number }[]> {
        const { rows } = await db.query<{ type: string; os: string; count: number }>(
            `SELECT
                device_type AS type,
                coalesce(os, '') AS os,
                COUNT(DISTINCT session_id)::int AS count
            FROM view_events
            WHERE book_id = $1 AND created_at >= $2 AND created_at < $3 AND device_type IS NOT NULL
            GROUP BY 1, 2
            ORDER BY count DESC, 1, 2`,
            [bookId, since, until],
        );
        return rows;
    },
};
