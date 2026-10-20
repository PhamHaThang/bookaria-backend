import type { Queryable } from '../../db';
import type { BookVersions, CheckAssetRow, CheckPageRow, PublishableBook } from './publish.types';

export const publishRepository = {
    // Lấy sách của tác giả để kiểm tra xem sách có thể xuất bản hay không
    async findBookForPublishing(
        db: Queryable,
        userId: string,
        bookId: string,
        opts: {
            lock?: boolean;
        } = {},
    ): Promise<PublishableBook | undefined> {
        const { rows } = await db.query<PublishableBook>(
            `SELECT b.id, b.page_aspect, (b.taken_down_at IS NOT NULL) AS taken_down, (u.email_verified_at IS NOT NULL) AS email_verified
            FROM books AS b
            JOIN users u ON u.id = b.owner_id
            WHERE b.id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL
            ${opts.lock ? 'FOR UPDATE' : ''}`,
            [bookId, userId],
        );
        return rows[0];
    },
    async getPagesOfBookForChecking(db: Queryable, bookId: string): Promise<CheckPageRow[]> {
        const { rows } = await db.query<CheckPageRow>(
            `SELECT p.id, p.order_index, p.marker_mode, p.marker_score, p.marker_report, p.scene, a.id AS image_id, a.status AS image_status, a.size_bytes AS image_bytes
            FROM pages AS p
            LEFT JOIN assets AS a ON p.image_asset_id = a.id AND a.deleted_at IS NULL
            WHERE p.book_id = $1
            ORDER BY p.order_index`,
            [bookId],
        );
        return rows;
    },
    // Lấy danh sách các asset của sách để kiểm tra xem sách có thể xuất bản hay không
    async getAssetsOfBookForChecking(db: Queryable, bookId: string): Promise<CheckAssetRow[]> {
        const { rows } = await db.query<CheckAssetRow>(
            `SELECT pa.page_id, a.id, a.status, a.size_bytes
            FROM page_assets pa
            JOIN pages p ON pa.page_id = p.id
            JOIN assets a ON pa.asset_id = a.id
            WHERE p.book_id = $1`,
            [bookId],
        );
        return rows;
    },
    // Lấy job xuất bản đang mở của sách
    async findOpenPublishJobByBookId(db: Queryable, bookId: string): Promise<string | undefined> {
        const { rows } = await db.query<{ id: string }>(
            `SELECT id
            FROM jobs
            WHERE type = 'PUBLISH_BOOK' AND ref_type = 'BOOK' AND ref_id = $1 AND status IN ('QUEUED', 'RUNNING')
            ORDER BY created_at LIMIT 1`,
            [bookId],
        );
        return rows[0]?.id;
    },
    // Tạo job xuất bản sách
    async insertPublishJob(
        db: Queryable,
        bookId: string,
        userId: string,
        payload: {
            visibility: 'UNLISTED' | 'PUBLIC';
            snapshotHash: string;
            acceptWarnings: boolean;
        },
    ): Promise<string> {
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO jobs (type, ref_type, ref_id, payload, created_by)
            VALUES ('PUBLISH_BOOK', 'BOOK', $1, $2::jsonb, $3)
            RETURNING id`,
            [bookId, JSON.stringify(payload), userId],
        );
        return (rows[0] as { id: string }).id;
    },
    // Lấy thông tin phiên bản của sách
    async getBookVersions(db: Queryable, bookId: string): Promise<BookVersions[]> {
        const { rows } = await db.query<BookVersions>(
            `SELECT v.id, v.version_no, v.page_count, v.ar_page_count, v.total_size_bytes, v.published_at, v.published_by, u.display_name AS published_by_name
            FROM book_versions v LEFT JOIN users u ON v.published_by = u.id
            WHERE book_id = $1
            ORDER BY v.version_no DESC`,
            [bookId],
        );
        return rows;
    },
    // Cập nhật sách thành chế độ riêng tư
    async setPrivate(db: Queryable, bookId: string) {
        await db.query(
            `UPDATE books
            SET visibility = 'PRIVATE'
            WHERE id = $1`,
            [bookId],
        );
    },
    // Lấy thông tin chia sẻ của sách
    async getShareInfo(db: Queryable, ownerId: string, bookId: string) {
        const { rows } = await db.query<{ slug: string; manifest_public_id: string }>(
            `
        SELECT b.slug,v.manifest_public_id FROM books b JOIN book_versions v ON v.id=b.current_version_id
        JOIN users u ON u.id=b.owner_id WHERE b.id=$1 AND b.owner_id=$2 AND b.deleted_at IS NULL
        AND b.taken_down_at IS NULL AND b.visibility<>'PRIVATE' AND b.slug IS NOT NULL
        AND u.status='ACTIVE'`,
            [bookId, ownerId],
        );
        return rows[0];
    },
};
