import { createHash } from 'node:crypto';
import type { Queryable } from '../../db';
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
            `SELECT id FROM assets WHERE id IN (SELECT image_asset_id FROM pages WHERE book_id = $1 UNION SELECT pa.asset_id FROM page_assets pa JOIN pages p ON p.id=pa.page_id WHERE p.book_id=$1) ORDER BY id FOR SHARE`,
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
