import type { Queryable } from '../../db';
import { JobError } from '../../modules/jobs/jobs.types';
import { capturePrintSource } from '../../modules/print/print.source';
import { readPublishSnapshot, snapshotHash } from '../../modules/publish/publish.snapshot';
import type { PublishSnapshot } from '../../modules/publish/publish.types';
import { PageSettingsSchema, PublishedSceneSchema, sceneAssetIds } from '../../schema';

export interface PublishedFiles {
    versionId: string;
    slug: string;
    visibility: 'PUBLIC' | 'UNLISTED';
    manifestId: string;
    groups: { group: number; public_id: string; page_ids: string[] }[];
    totalBytes: number;
    arCount: number;
}
/**
 * Commit bản xuất bản mới vào cơ sở dữ liệu. Nếu sách đã thay đổi từ lúc tạo snapshot, sẽ ném lỗi.
 */
export async function commitPublication(
    db: Queryable,
    snapshot: PublishSnapshot,
    expectedHash: string,
    files: PublishedFiles,
): Promise<void> {
    const current = await readPublishSnapshot(db, snapshot.book.owner_id, snapshot.book.id, true);
    if (!current || snapshotHash(current) !== expectedHash)
        throw new JobError(
            'PUBLISH_STALE',
            'Sách đã thay đổi. Bản cũ được giữ nguyên; hãy kiểm tra và xuất bản lại.',
        );
    await db.query(
        `INSERT INTO book_versions (id,book_id,version_no,schema_version,manifest_public_id,mind_groups,page_count,ar_page_count,total_size_bytes,published_by,print_source)
        VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb)`,
        [
            files.versionId,
            snapshot.book.id,
            snapshot.version,
            files.manifestId,
            JSON.stringify(files.groups),
            snapshot.pages.length,
            files.arCount,
            files.totalBytes,
            snapshot.book.owner_id,
            JSON.stringify(capturePrintSource(snapshot)),
        ],
    );
    const assetIds = new Set(snapshot.pages.map((page) => page.image_asset_id));
    for (const page of snapshot.pages) {
        const scene = PublishedSceneSchema.parse(page.scene);
        const settings = PageSettingsSchema.parse(page.settings);
        for (const id of sceneAssetIds(scene, settings)) assetIds.add(id);
    }
    await db.query(
        `INSERT INTO version_assets (book_version_id, asset_id)
         SELECT $1::uuid, unnest($2::uuid[])`,
        [files.versionId, [...assetIds]],
    );
    await db.query(
        `UPDATE books SET current_version_id=$2,slug=COALESCE(slug,$3),status='PUBLISHED', visibility=$4,first_published_at=COALESCE(first_published_at,now())
        WHERE id=$1`,
        [snapshot.book.id, files.versionId, files.slug, files.visibility],
    );
}
