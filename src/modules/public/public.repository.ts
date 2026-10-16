import { escapeLike, type Queryable } from '../../db';
import type { AuthorRow, CardBookRow, EventBook, NewEvent, PublicBookRow } from './public.types';

const SHOWN_BOOK_CONDITION = `b.deleted_at IS NULL AND b.taken_down_at IS NULL AND b.current_version_id IS NOT NULL AND u.status = 'ACTIVE'`;

const PUBLIC_BOOK_CONDITION = `${SHOWN_BOOK_CONDITION} AND b.visibility = 'PUBLIC'`;

const CARD_BOOK_COLUMNS = `b.slug, b.title, b.language, b.age_min, b.age_max, b.owner_id, u.display_name AS author_name, v.ar_page_count, ca.original_public_id AS cover_public_id, ca.resource_type AS cover_resource_type`;

const CARD_BOOK_JOIN = `JOIN users u ON u.id = b.owner_id
JOIN book_versions v ON v.id = b.current_version_id
LEFT JOIN assets ca ON ca.id = b.cover_asset_id AND ca.deleted_at IS NULL`;

export const publicRepository = {
    async getPublicBooks(
        db: Queryable,
        opts: {
            q?: string | undefined;
            age?: number | undefined;
            topic?: string | undefined;
            language?: string | undefined;
            sort: 'newest' | 'popular';
            limit: number;
            offset: number;
        },
    ): Promise<{ rows: CardBookRow[]; total: number }> {
        const where = [PUBLIC_BOOK_CONDITION];
        const params: unknown[] = [];
        const add = (sql: string, value: unknown) => {
            params.push(value);
            where.push(sql.replace('?', `$${params.length}`));
        };

        if (opts.q) {
            add(`(b.title ILIKE ?)`, `%${escapeLike(opts.q)}%`);
        }

        if (opts.age !== undefined) {
            add(`(b.age_min IS NULL OR b.age_min <= ?)`, opts.age);
            add(`(b.age_max IS NULL OR b.age_max >= ?)`, opts.age);
        }

        if (opts.topic) {
            add(`b.topic = ?`, opts.topic);
        }

        if (opts.language) {
            add(`b.language = ?`, opts.language);
        }
        const whereClause = where.join(' AND ');
        const order =
            opts.sort === 'popular'
                ? 'b.view_count DESC, b.first_published_at DESC, b.id'
                : 'b.first_published_at DESC, b.id';

        const { rows } = await db.query<CardBookRow>(
            `SELECT ${CARD_BOOK_COLUMNS} FROM books b ${CARD_BOOK_JOIN} WHERE ${whereClause}
            ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, opts.limit, opts.offset],
        );
        const count = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM books b JOIN users u ON u.id = b.owner_id WHERE ${whereClause}`,
            params,
        );
        return { rows, total: count.rows[0]?.n ?? 0 };
    },

    async getAuthorProfile(db: Queryable, authorId: string): Promise<AuthorRow | undefined> {
        const { rows } = await db.query(
            `SELECT u.id, u.display_name, u.organization, u.bio, u.avatar_url
            FROM users u
            WHERE u.id = $1 AND u.status = 'ACTIVE'
                AND EXISTS (SELECT 1 FROM books b WHERE b.owner_id = u.id AND ${PUBLIC_BOOK_CONDITION})`,
            [authorId],
        );
        return rows[0];
    },

    async getPublicBooksOfAuthor(db: Queryable, authorId: string): Promise<CardBookRow[]> {
        const { rows } = await db.query<CardBookRow>(
            `SELECT ${CARD_BOOK_COLUMNS} FROM books b ${CARD_BOOK_JOIN}
            WHERE b.owner_id = $1 AND ${PUBLIC_BOOK_CONDITION}
            ORDER BY b.first_published_at DESC, b.id`,
            [authorId],
        );
        return rows;
    },

    async getBookBySlug(db: Queryable, slug: string): Promise<PublicBookRow | undefined> {
        const { rows } = await db.query<PublicBookRow>(
            `SELECT b.id, b.description, b.visibility, b.deleted_at, b.taken_down_at, (u.status = 'ACTIVE') AS owner_active, v.id AS version_id, v.version_no, v.published_at, v.manifest_public_id, v.page_count, v.total_size_bytes, v.print_pdf_public_id, b.slug, b.title, b.language, b.age_min, b.age_max, b.owner_id, u.display_name AS author_name, v.ar_page_count, ca.original_public_id AS cover_public_id, ca.resource_type AS cover_resource_type
            FROM books b
            JOIN users u ON u.id = b.owner_id
            LEFT JOIN book_versions v ON v.id = b.current_version_id
            LEFT JOIN assets ca ON ca.id = b.cover_asset_id AND ca.deleted_at IS NULL
            WHERE b.slug = $1`,
            [slug],
        );
        return rows[0];
    },

    // Lấy version của sách dựa trên versionId, chỉ lấy những sách không phải PRIVATE và thỏa mãn điều kiện SHOWN_BOOK_CONDITION
    async getVersionBook(db: Queryable, versionId: string): Promise<EventBook | undefined> {
        const { rows } = await db.query<EventBook>(
            `SELECT v.id AS version_id, b.id AS book_id
            FROM book_versions v
            JOIN books b ON b.id = v.book_id
            JOIN users u ON u.id = b.owner_id
            WHERE v.id = $1 AND b.visibility <> 'PRIVATE' AND ${SHOWN_BOOK_CONDITION}`,
            [versionId],
        );
        return rows[0];
    },
    // Lấy danh sách pageId hợp lệ của sách dựa trên bookId và danh sách pageIds, chỉ lấy những pageId thuộc sách có bookId và tồn tại trong danh sách pageIds
    async getValidPageIds(db: Queryable, bookId: string, pageIds: string[]): Promise<Set<string>> {
        const { rows } = await db.query<{ id: string }>(
            `SELECT id FROM pages WHERE book_id = $1 AND id = ANY($2::uuid[])`,
            [bookId, pageIds],
        );
        return new Set(rows.map((r) => r.id));
    },

    // Kiểm tra xem một pageId có thuộc sách có bookId hay không
    async isPageInBook(db: Queryable, bookId: string, pageId: string): Promise<boolean> {
        const { rows } = await db.query(`SELECT 1 FROM pages WHERE book_id = $1 AND id = $2`, [
            bookId,
            pageId,
        ]);
        return rows.length > 0;
    },

    // --- VIEW EVENTS -----------------------
    // Lưu các sự kiện tương tác với sách
    async insertViewEvents(
        db: Queryable,
        o: {
            bookId: string;
            versionId: string;
            sessionId: string | null;
            device: {
                type: string;
                os: string;
                browser: string;
            };
            events: NewEvent[];
        },
    ): Promise<void> {
        await db.query(
            `INSERT INTO view_events (book_id, book_version_id, page_id, event, object_id, session_id, device_type, os, browser)
            SELECT $1, $2, e.page_id, e.event::view_event_type, e.object_id, $3, $4, $5, $6
            FROM UNNEST($7::uuid[], $8::text[], $9::text[]) AS e(page_id, event, object_id)`,
            [
                o.bookId,
                o.versionId,
                o.sessionId,
                o.device.type,
                o.device.os,
                o.device.browser,
                o.events.map((e) => e.pageId),
                o.events.map((e) => e.event),
                o.events.map((e) => e.objectId),
            ],
        );
    },

    async addViewCount(db: Queryable, bookId: string, count: number): Promise<void> {
        if (count > 0) {
            await db.query(`UPDATE books SET view_count = view_count + $1 WHERE id = $2`, [
                count,
                bookId,
            ]);
        }
    },
    // --- REPORTS -----------------------
    // Lock reporter khi có nhiều request cùng báo cáo một sách, tránh tình trạng double report
    // Sử dụng pg_advisory_xact_lock để lock theo hash của bookId và fingerprint, đảm bảo rằng chỉ có một transaction được thực hiện cho mỗi cặp bookId và fingerprint
    async lockReporter(db: Queryable, bookId: string, fingerprint: string) {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `report:${bookId}:${fingerprint}`,
        ]);
    },
    // Lấy thời gian báo cáo cuối cùng của một sách trong khoảng thời gian nhất định, dựa trên bookId và fingerprint
    async getLastReportWithin(
        db: Queryable,
        bookId: string,
        fingerprint: string,
        hours: number,
    ): Promise<Date | null> {
        const { rows } = await db.query<{ created_at: Date | null }>(
            `SELECT max(created_at) AS created_at FROM reports
            WHERE book_id = $1 AND reporter_fingerprint = $2 AND created_at >= NOW() - MAKE_INTERVAL(hours => $3)`,
            [bookId, fingerprint, hours],
        );
        return rows[0]?.created_at ?? null;
    },
    async insertReport(
        db: Queryable,
        o: {
            bookId: string;
            pageId: string | null;
            reason: string;
            note: string | null;
            fingerprint: string;
        },
    ): Promise<void> {
        await db.query(
            `INSERT INTO reports (book_id, page_id, reason, note, reporter_fingerprint)
            VALUES ($1, $2, $3::report_reason, $4, $5)`,
            [o.bookId, o.pageId, o.reason, o.note, o.fingerprint],
        );
    },
};
