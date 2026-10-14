// Phân quyền: trang thuộc về một sách, sách thuộc về một tác giả. Mọi hàm nhận `userId` đều kiểm
// tra quyền sở hữu qua sách (`b.owner_id = $n`).

import type { Queryable } from '../../db';
import type { EditableBook } from '../books/books.types';
import type { NewPage, PageAssetRow, PageRow } from './pages.types';

const PAGE_COLUMNS = `p.id, p.book_id, p.order_index, p.title, p.marker_mode, p.marker_score, p.marker_report, m.number AS marker_number, p.bookaria_marker_transform AS marker_transform, jsonb_array_length(p.scene -> 'objects')::int AS object_count, p.settings, p.revision, p.updated_at, p.image_asset_id, a.resource_type AS img_resource_type, a.original_public_id AS img_original_public_id, a.optimized_public_id AS img_optimized_public_id, a.format AS img_format, a.thumbnail_url AS img_thumbnail_url, a.meta AS img_meta`;

const PAGE_JOINS = `FROM pages p JOIN assets a ON a.id = p.image_asset_id LEFT JOIN bookaria_markers m ON m.id = p.bookaria_marker_id`;

export const pagesRepository = {
    async getPages(db: Queryable, bookId: string): Promise<PageRow[]> {
        const { rows } = await db.query<PageRow>(
            `SELECT ${PAGE_COLUMNS} ${PAGE_JOINS} WHERE p.book_id = $1 ORDER BY p.order_index`,
            [bookId],
        );
        return rows;
    },
    async getPageById(db: Queryable, userId: string, pageId: string): Promise<PageRow | undefined> {
        const { rows } = await db.query<PageRow>(
            `SELECT ${PAGE_COLUMNS} ${PAGE_JOINS} JOIN books b ON b.id = p.book_id
             WHERE p.id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL`,
            [pageId, userId],
        );
        return rows[0];
    },
    async loadScene(
        db: Queryable,
        pageId: string,
        opts: { lock?: boolean } = {},
    ): Promise<{ scene: unknown; settings: unknown } | undefined> {
        const { rows } = await db.query<{ scene: unknown; settings: unknown }>(
            `SELECT p.scene, p.settings FROM pages p WHERE p.id = $1 ${opts.lock ? 'FOR UPDATE' : ''}`,
            [pageId],
        );
        return rows[0];
    },
    async lockBookOfPage(
        db: Queryable,
        userId: string,
        pageId: string,
    ): Promise<(EditableBook & { id: string }) | undefined> {
        const { rows } = await db.query<EditableBook & { id: string }>(
            `SELECT b.id, b.age_min, b.age_max, b.page_format, b.page_aspect,
            (b.taken_down_at IS NOT NULL) AS taken_down
            FROM books b JOIN pages p ON p.book_id = b.id
            WHERE p.id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL
            FOR UPDATE OF b`,
            [pageId, userId],
        );
        return rows[0];
    },
    async getOrderIndexOfPage(
        db: Queryable,
        bookId: string,
        pageId: string,
    ): Promise<number | undefined> {
        const { rows } = await db.query<{ order_index: number }>(
            `SELECT p.order_index FROM pages p WHERE p.id = $1 AND p.book_id = $2`,
            [pageId, bookId],
        );
        return rows[0]?.order_index;
    },
    async getNextOrderIndex(db: Queryable, bookId: string): Promise<number> {
        const { rows } = await db.query<{ next_index: number }>(
            `SELECT COALESCE(MAX(p.order_index)+ 1, 0)::int AS next_index FROM pages p WHERE p.book_id = $1`,
            [bookId],
        );
        return rows[0]?.next_index ?? 0;
    },
    // Dịch chuyển các trang từ một chỉ số nhất định sang phải một đơn vị, để chèn một trang mới vào giữa.
    async shiftPagesFrom(db: Queryable, bookId: string, fromIndex: number): Promise<void> {
        await db.query(
            `UPDATE pages SET order_index = order_index + 1 WHERE book_id = $1 AND order_index >= $2`,
            [bookId, fromIndex],
        );
    },
    // Dịch chuyển các trang từ một chỉ số nhất định sang trái một đơn vị, để xóa một trang ra khỏi giữa.
    async closeGapAfter(db: Queryable, bookId: string, fromIndex: number): Promise<void> {
        await db.query(
            `UPDATE pages SET order_index = order_index - 1 WHERE book_id = $1 AND order_index > $2`,
            [bookId, fromIndex],
        );
    },
    async getPageIdsInOrder(db: Queryable, bookId: string): Promise<string[]> {
        const { rows } = await db.query<{ id: string }>(
            `SELECT p.id FROM pages p WHERE p.book_id = $1 ORDER BY p.order_index`,
            [bookId],
        );
        return rows.map((r) => r.id);
    },
    /** Đưa các trang vào vị trí mới theo thứ tự của `ids`. */
    async reorderPages(db: Queryable, ids: string[]): Promise<void> {
        await db.query(
            `UPDATE pages p SET order_index = v.position::int - 1
            FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, position)
            WHERE p.id = v.id`,
            [ids],
        );
    },
    /** Lấy ra Marker có số thứ tự trống thấp nhất sẵn sàng để sử dụng. */
    async getLowestFreeMarker(
        db: Queryable,
        bookId: string,
    ): Promise<{ id: string; number: number } | undefined> {
        const { rows } = await db.query<{ id: string; number: number }>(
            `SELECT m.id, m.number FROM bookaria_markers m
            WHERE m.validated_at IS NOT NULL AND m.is_active AND NOT EXISTS
                (SELECT 1 FROM pages p WHERE p.bookaria_marker_id = m.id AND p.book_id = $1)
            ORDER BY m.number LIMIT 1`,
            [bookId],
        );
        return rows[0];
    },

    async insertPage(db: Queryable, page: NewPage): Promise<string> {
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO pages (book_id, order_index, title, image_asset_id, marker_mode,
            bookaria_marker_id, bookaria_marker_transform, scene, settings)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::jsonb, '{"schemaVersion":1,"objects":[],"interactions":[]}'::jsonb), COALESCE($9::jsonb, '{}'::jsonb))
            RETURNING id`,
            [
                page.bookId,
                page.orderIndex,
                page.title,
                page.imageAssetId,
                page.marker ? 'BOOKARIA_MARKER' : 'NONE',
                page.marker?.id ?? null,
                page.marker ? JSON.stringify(page.marker.transform) : null,
                page.scene === undefined ? null : JSON.stringify(page.scene),
                page.settings === undefined ? null : JSON.stringify(page.settings),
            ],
        );
        return (rows[0] as { id: string }).id;
    },
    async updatePage(
        db: Queryable,
        pageId: string,
        changes: Record<string, string | number | null>,
    ): Promise<void> {
        const columns = Object.keys(changes);
        const assignments = columns.map((column, i) => `${column} = $${i + 2}`).join(', ');
        await db.query(`UPDATE pages SET ${assignments} WHERE id = $1`, [
            pageId,
            ...columns.map((column) => changes[column]),
        ]);
    },
    async setSettings(db: Queryable, pageId: string, settings: unknown): Promise<void> {
        await db.query(`UPDATE pages SET settings = $2::jsonb WHERE id = $1`, [
            pageId,
            JSON.stringify(settings),
        ]);
    },
    async setBookariaMarker(
        db: Queryable,
        pageId: string,
        marker: {
            id: string;
            transform: unknown;
        } | null,
    ): Promise<void> {
        await db.query(
            `UPDATE pages
            SET marker_mode = $2, bookaria_marker_id = $3, bookaria_marker_transform = $4::jsonb, marker_mind_public_id = NULL, marker_score = NULL, marker_features = NULL, marker_report = NULL
            WHERE id = $1`,
            [
                pageId,
                marker ? 'BOOKARIA_MARKER' : 'NONE',
                marker?.id ?? null,
                marker ? JSON.stringify(marker.transform) : null,
            ],
        );
    },
    async deletePage(db: Queryable, pageId: string): Promise<void> {
        await db.query(`DELETE FROM pages WHERE id = $1`, [pageId]);
    },
    async updateBookUpdatedAt(db: Queryable, bookId: string): Promise<void> {
        await db.query(`UPDATE books SET updated_at = NOW() WHERE id = $1`, [bookId]);
    },

    // --- Tài nguyên mà trang sử dụng ---
    async replacePageAssets(db: Queryable, pageId: string, newAssetIds: string[]): Promise<void> {
        await db.query(
            `DELETE FROM page_assets WHERE page_id = $1 AND asset_id <> ALL($2::uuid[])`,
            [pageId, newAssetIds],
        );
        await db.query(
            `INSERT INTO page_assets (page_id, asset_id)
            SELECT $1, unnest($2::uuid[])
            ON CONFLICT DO NOTHING`,
            [pageId, newAssetIds],
        );
    },
    async getPageAssets(db: Queryable, pageId: string): Promise<PageAssetRow[]> {
        const { rows } = await db.query<PageAssetRow>(
            `SELECT a.id, a.type, a.resource_type, a.original_public_id, a.optimized_public_id, a.format, a.thumbnail_url, a.meta
            FROM page_assets pa JOIN assets a ON a.id = pa.asset_id
            WHERE pa.page_id = $1 ORDER BY a.id`,
            [pageId],
        );
        return rows;
    },
    async hasOpenBookJob(db: Queryable, bookId: string): Promise<boolean> {
        const { rows } = await db.query<{ open: boolean }>(
            `SELECT EXISTS(
                SELECT 1 FROM jobs WHERE status IN ('QUEUED', 'RUNNING') AND ref_type = 'BOOK' AND ref_id = $1)
            AS open`,
            [bookId],
        );
        return rows[0]?.open === true;
    },
    async insertScoreJob(db: Queryable, pageId: string, userId: string): Promise<string> {
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO jobs (type, ref_type, ref_id, created_by)
            VALUES ('SCORE_MARKER', 'PAGE', $1, $2)
            RETURNING id`,
            [pageId, userId],
        );
        return (rows[0] as { id: string }).id;
    },
    /** Trang marker riêng nhận file `.mind` mới; điểm số và báo cáo cũ không còn đúng nên bị xoá. */
    async setCustomMarkerFile(
        db: Queryable,
        pageId: string,
        mindPublicId: string | null,
    ): Promise<void> {
        await db.query(
            `UPDATE pages
            SET marker_mind_public_id = $2, marker_score = NULL, marker_features = NULL,
            marker_report = NULL
            WHERE id = $1`,
            [pageId, mindPublicId],
        );
    },
    /** Trang chuyển sang marker riêng: ảnh của trang là marker, `.mind` là file đã biên dịch. */
    async setCustomMarker(db: Queryable, pageId: string, mindPublicId: string): Promise<void> {
        await db.query(
            `UPDATE pages
            SET marker_mode = 'CUSTOM_MARKER', bookaria_marker_id = NULL, bookaria_marker_transform = NULL, marker_mind_public_id = $2, marker_score = NULL, marker_features = NULL, marker_report = NULL
            WHERE id = $1`,
            [pageId, mindPublicId],
        );
    },
    async setMarkerTransform(db: Queryable, pageId: string, transform: unknown): Promise<void> {
        await db.query(`UPDATE pages SET bookaria_marker_transform = $2::jsonb WHERE id = $1`, [
            pageId,
            JSON.stringify(transform),
        ]);
    },
    /** Trang có tác vụ chấm điểm marker đang chờ hoặc chạy không? Nếu có thì chưa cho đổi marker. */
    async hasOpenScoreJob(db: Queryable, pageId: string): Promise<boolean> {
        const { rows } = await db.query<{ open: boolean }>(
            `SELECT EXISTS(
                SELECT 1 FROM jobs WHERE status IN ('QUEUED', 'RUNNING') AND type = 'SCORE_MARKER' AND ref_type = 'PAGE' AND ref_id = $1)
            AS open`,
            [pageId],
        );
        return rows[0]?.open === true;
    },
    async getBookGeometry(
        db: Queryable,
        bookId: string,
    ): Promise<Pick<EditableBook, 'page_format' | 'page_aspect'> | undefined> {
        const { rows } = await db.query<Pick<EditableBook, 'page_format' | 'page_aspect'>>(
            `SELECT page_format, page_aspect FROM books WHERE id = $1`,
            [bookId],
        );
        return rows[0];
    },
    async lockSceneRevision(
        db: Queryable,
        pageId: string,
    ): Promise<
        | {
              revision: number;
              scene: unknown;
          }
        | undefined
    > {
        const { rows } = await db.query<{ revision: number; scene: unknown }>(
            `SELECT revision, scene FROM pages WHERE id = $1 FOR UPDATE`,
            [pageId],
        );
        return rows[0];
    },
    async updateSceneAndRevision(
        db: Queryable,
        pageId: string,
        scene: unknown,
    ): Promise<{ revision: number; updated_at: Date }> {
        const { rows } = await db.query<{ revision: number; updated_at: Date }>(
            `UPDATE pages SET scene = $2::jsonb, revision = revision + 1
            WHERE id = $1 RETURNING revision, updated_at`,
            [pageId, JSON.stringify(scene)],
        );
        return rows[0] as { revision: number; updated_at: Date };
    },
    async getAssetBytesByIds(db: Queryable, assetIds: string[]): Promise<number> {
        if (assetIds.length === 0) return 0;
        const { rows } = await db.query<{ total: number }>(
            `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM assets
            WHERE id = ANY($1::uuid[])`,
            [assetIds],
        );
        return Number(rows[0]?.total ?? 0);
    },
};
