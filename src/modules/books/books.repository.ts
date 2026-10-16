import { buildOrderBy, escapeLike, type Queryable } from '../../db';
import type { BookDetailRow, BookRow, EditableBook } from './books.types';

const SUMMARY_COLUMNS = `b.id, b.title, b.cover_asset_id, b.status, b.visibility, ca.original_public_id AS cover_public_id, ca.resource_type AS cover_resource_type, (b.taken_down_at IS NOT NULL) AS taken_down, (SELECT count(*)::int FROM pages p WHERE p.book_id = b.id) AS page_count, b.updated_at, b.deleted_at`;

const COVER_JOIN = `LEFT JOIN assets ca ON ca.id = b.cover_asset_id AND ca.deleted_at IS NULL`;

const SORT_COLUMNS = {
    updatedAt: 'b.updated_at',
    createdAt: 'b.created_at',
    title: 'b.title',
} as const;

export const booksRepository = {
    async getBooks(
        db: Queryable,
        ownerId: string,
        opts: {
            q?: string | undefined;
            status?: string | undefined;
            sort: string;
            limit: number;
            offset: number;
        },
    ): Promise<{ rows: BookRow[]; total: number }> {
        const { q, status, sort, limit, offset } = opts;
        const whereClauses = [`b.owner_id = $1`, `b.deleted_at IS NULL`];
        const params: unknown[] = [ownerId];
        if (q) {
            params.push(`%${escapeLike(q)}%`);
            whereClauses.push(`(b.title ILIKE $${params.length} ESCAPE '\\')`);
        }
        if (status) {
            params.push(status);
            whereClauses.push(`b.status = $${params.length}`);
        }
        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const orderBySql = buildOrderBy(sort, SORT_COLUMNS);
        const sql = `
            SELECT ${SUMMARY_COLUMNS}
            FROM books b
            ${COVER_JOIN}
            ${whereSql}
            ORDER BY ${orderBySql}
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        const { rows } = await db.query<BookRow>(sql, [...params, limit, offset]);
        const totalSql = `SELECT count(*)::int AS total FROM books b ${whereSql}`;
        const count = await db.query<{ total: number }>(totalSql, params);
        return { rows, total: count.rows[0]?.total ?? 0 };
    },
    async getTrashBooks(
        db: Queryable,
        ownerId: string,
        opts: {
            trashDays: number;
            limit: number;
            offset: number;
        },
    ): Promise<{ rows: BookRow[]; total: number }> {
        const { trashDays, limit, offset } = opts;
        const clause = `b.owner_id = $1 AND b.deleted_at IS NOT NULL AND b.deleted_at > NOW() - MAKE_INTERVAL(days => $2)`;
        const { rows } = await db.query<BookRow>(
            `
            SELECT ${SUMMARY_COLUMNS}
            FROM books b
            ${COVER_JOIN}
            WHERE ${clause}
            ORDER BY b.deleted_at DESC, b.id LIMIT $3 OFFSET $4
        `,
            [ownerId, trashDays, limit, offset],
        );
        const count = await db.query<{ total: number }>(
            `SELECT count(*)::int AS total FROM books b ${COVER_JOIN} WHERE ${clause}`,
            [ownerId, trashDays],
        );
        return { rows, total: count.rows[0]?.total ?? 0 };
    },
    /** A book of this user that is not in the trash, as a summary. */
    async getBookSummary(
        db: Queryable,
        ownerId: string,
        bookId: string,
    ): Promise<BookRow | undefined> {
        const { rows } = await db.query<BookRow>(
            `SELECT ${SUMMARY_COLUMNS} FROM books b
            ${COVER_JOIN}
            WHERE b.id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL`,
            [bookId, ownerId],
        );
        return rows[0];
    },
    async getDetailBook(
        db: Queryable,
        ownerId: string,
        bookId: string,
    ): Promise<BookDetailRow | undefined> {
        const { rows } = await db.query<BookDetailRow>(
            `SELECT ${SUMMARY_COLUMNS}, b.description, b.age_min, b.age_max, b.language, b.topic, b.page_format, b.page_aspect, b.slug, v.version_no, v.published_at AS version_published_at
            FROM books b
            LEFT JOIN book_versions v ON v.id = b.current_version_id
            ${COVER_JOIN}
            WHERE b.id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL`,
            [bookId, ownerId],
        );
        return rows[0];
    },
    async lockEditableBook(
        db: Queryable,
        ownerId: string,
        bookId: string,
    ): Promise<EditableBook | undefined> {
        const { rows } = await db.query<EditableBook>(
            `SELECT b.age_min, b.age_max, b.page_format, b.page_aspect, (b.taken_down_at IS NOT NULL) AS taken_down
            FROM books b
            WHERE b.id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL
            FOR UPDATE`,
            [bookId, ownerId],
        );
        return rows[0];
    },
    async insertBook(
        db: Queryable,
        ownerId: string,
        book: {
            title: string;
            description: string | null;
            ageMin: number | null;
            ageMax: number | null;
            language: string;
            topic: string | null;
            pageFormat: string;
            pageAspect: number;
            pageWidthMm: number;
        },
    ): Promise<string> {
        const {
            title,
            description,
            ageMax,
            ageMin,
            language,
            topic,
            pageFormat,
            pageAspect,
            pageWidthMm,
        } = book;
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO books (owner_id, title, description, age_min, age_max, language, topic, page_format, page_aspect, page_width_mm)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING id`,
            [
                ownerId,
                title,
                description,
                ageMin,
                ageMax,
                language,
                topic,
                pageFormat,
                pageAspect,
                pageWidthMm,
            ],
        );
        return (rows[0] as { id: string }).id;
    },
    async updateBook(
        db: Queryable,
        bookId: string,
        changes: Record<string, string | number | null>,
    ): Promise<void> {
        const columns = Object.keys(changes);
        const assignments = columns.map((column, i) => `${column} = $${i + 2}`).join(', ');
        await db.query(`UPDATE books SET ${assignments} WHERE id = $1`, [
            bookId,
            ...columns.map((column) => changes[column]),
        ]);
    },
    async hasOpenJob(db: Queryable, bookId: string): Promise<boolean> {
        const { rows } = await db.query<{ open: boolean }>(
            `SELECT EXISTS (
                SELECT 1 FROM jobs j
                WHERE j.status IN ('QUEUED', 'RUNNING')
                AND ((ref_type = 'BOOK' AND ref_id = $1)
                    OR (ref_type = 'PAGE' AND ref_id IN (SELECT id FROM pages WHERE book_id = $1))))
            AS open`,
            [bookId],
        );
        return rows[0]?.open === true;
    },
    /** Soft deletes a book, marking it as deleted. */
    async softDeleteBook(db: Queryable, ownerId: string, bookId: string): Promise<boolean> {
        const res = await db.query(
            `UPDATE books SET deleted_at = NOW() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
            [bookId, ownerId],
        );
        return res.rowCount === 1;
    },
    /** Takes a book out of the trash, if it went in less than `trashDays` days ago. */
    async restoreBook(
        db: Queryable,
        ownerId: string,
        bookId: string,
        trashDays: number,
    ): Promise<boolean> {
        const res = await db.query(
            `UPDATE books SET deleted_at = NULL
            WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL AND deleted_at > NOW() - MAKE_INTERVAL(days => $3)`,
            [bookId, ownerId, trashDays],
        );
        return res.rowCount === 1;
    },
};
