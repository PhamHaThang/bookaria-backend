import { createHash } from 'node:crypto';
import type { Queryable } from '../../db';
import { JobError } from '../jobs/jobs.types';
import type { PublishSnapshot } from './publish.types';

export async function readPublishSnapshot(
    db: Queryable,
    ownerId: string,
    bookId: string,
    lock = false,
): Promise<PublishSnapshot | undefined> {
    if (lock) {
        // Khóa bản ghi sách để tránh xung đột.
        await db.query('SELECT id FROM books WHERE id = $1 AND owner_id = $2 FOR UPDATE', [
            bookId,
            ownerId,
        ]);
        // Khóa bản ghi người dùng để tránh xung đột.
        await db.query('SELECT id FROM users WHERE id = $1 FOR SHARE', [ownerId]);
        // Khóa bản ghi trang để tránh xung đột.
        await db.query('SELECT id FROM pages WHERE book_id = $1 ORDER BY id FOR SHARE', [bookId]);
        // Khóa bản ghi tài nguyên để tránh xung đột.
        await db.query(
            `SELECT id FROM assets WHERE id IN (SELECT image_asset_id FROM pages WHERE book_id = $1 UNION SELECT cover_asset_id FROM books WHERE id = $1 UNION SELECT pa.asset_id FROM page_assets pa JOIN pages p ON p.id=pa.page_id WHERE p.book_id=$1) ORDER BY id FOR SHARE`,
            [bookId],
        );
        // Khóa bản ghi marker để tránh xung đột.
        await db.query(
            `
            SELECT id FROM bookaria_markers WHERE id IN (SELECT bookaria_marker_id FROM pages WHERE book_id = $1) ORDER BY id FOR SHARE
        `,
            [bookId],
        );
    }
    const { rows } = await db.query<{ snapshot: PublishSnapshot }>(
        `SELECT jsonb_build_object(
            'book', to_jsonb(b) - 'updated_at' - 'view_count',
            'author', jsonb_build_object('status',u.status,'email_verified_at',u.email_verified_at),
            'version', (SELECT COALESCE(max(v.version_no),0)+1 FROM book_versions v WHERE v.book_id=b.id),
            'pages', COALESCE((SELECT jsonb_agg(to_jsonb(p)-'updated_at'-'revision' ORDER BY p.order_index,p.id)
                FROM pages p WHERE p.book_id=b.id),'[]'::jsonb),
            'assets', COALESCE((SELECT jsonb_agg(to_jsonb(a)-'updated_at' ORDER BY a.id) FROM assets a WHERE a.id IN (
                SELECT image_asset_id FROM pages WHERE book_id=b.id UNION
                SELECT b.cover_asset_id UNION
                SELECT pa.asset_id FROM page_assets pa JOIN pages p ON p.id=pa.page_id WHERE p.book_id=b.id
            )),'[]'::jsonb),
            'markers', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM bookaria_markers m
                WHERE m.id IN (SELECT bookaria_marker_id FROM pages WHERE book_id=b.id)),'[]'::jsonb)
        ) AS snapshot FROM books b JOIN users u ON u.id=b.owner_id WHERE b.id=$1 AND b.owner_id=$2`,
        [bookId, ownerId],
    );
    return rows[0]?.snapshot;
}

export function snapshotHash(snapshot: PublishSnapshot): string {
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/** Check live permissions and retained resources without comparing the mutable draft. */
export async function assertPublicationAvailable(
    db: Queryable,
    snapshot: PublishSnapshot,
    lock = false,
) {
    const { rows } = await db.query<{
        deleted_at: string | null;
        taken_down_at: string | null;
        current_version_id: string | null;
        status: string;
        email_verified_at: string | null;
    }>(
        `SELECT b.deleted_at,b.taken_down_at,b.current_version_id,u.status,u.email_verified_at
        FROM books b JOIN users u ON u.id=b.owner_id WHERE b.id=$1 AND b.owner_id=$2
        ${lock ? 'FOR UPDATE OF b FOR SHARE OF u' : ''}`,
        [snapshot.book.id, snapshot.book.owner_id],
    );
    const book = rows[0];
    if (
        !book ||
        book.deleted_at ||
        book.taken_down_at ||
        book.status !== 'ACTIVE' ||
        !book.email_verified_at
    )
        throw new JobError(
            'PUBLISH_UNAVAILABLE',
            'Sách hoặc tài khoản không còn đủ điều kiện xuất bản.',
        );
    if (book.current_version_id !== snapshot.book.current_version_id)
        throw new JobError(
            'PUBLISH_STALE',
            'Đã có phiên bản mới hơn. Hãy tải lại trạng thái xuất bản.',
        );
    const assets = await db.query<{ id: string }>(
        `SELECT id FROM assets WHERE id=ANY($1::uuid[])
        AND deleted_at IS NULL AND status='READY' AND (owner_id IS NULL OR owner_id=$2)
        ORDER BY id ${lock ? 'FOR SHARE' : ''}`,
        [snapshot.assets.map((a) => a.id), snapshot.book.owner_id],
    );
    if (assets.rows.length !== snapshot.assets.length)
        throw new JobError(
            'PUBLISH_ASSET_UNAVAILABLE',
            'Tài nguyên của bản xuất bản đã bị gỡ hoặc không còn sẵn sàng.',
        );
    const markers = await db.query<{ id: string }>(
        `SELECT id FROM bookaria_markers WHERE id=ANY($1::uuid[])
        AND is_active AND validated_at IS NOT NULL ORDER BY id ${lock ? 'FOR SHARE' : ''}`,
        [snapshot.markers.map((m) => m.id)],
    );
    if (markers.rows.length !== snapshot.markers.length)
        throw new JobError(
            'INVALID_BOOKARIA_MARKER',
            'Marker Bookaria đã bị tắt hoặc chưa được kiểm định.',
        );
}

/** Ignore publication bookkeeping; compare the actual authoring content. */
export function publicationContentHash(snapshot: PublishSnapshot): string {
    const b = snapshot.book as unknown as Record<string, unknown>;
    return snapshotHash({
        ...snapshot,
        version: 0,
        author: { status: '', email_verified_at: null },
        book: Object.fromEntries(
            [
                'id',
                'owner_id',
                'title',
                'description',
                'cover_asset_id',
                'page_format',
                'page_aspect',
                'page_width_mm',
                'language',
                'topic',
                'age_min',
                'age_max',
            ].map((key) => [key, b[key]]),
        ),
    } as unknown as PublishSnapshot);
}
