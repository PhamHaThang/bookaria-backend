import { z } from 'zod';
import type { Queryable } from '../../db';
import {
    CreatePreviewBodySchema,
    MarkerTransformSchema,
    PageSettingsSchema,
    PublishedSceneSchema,
    sceneAssetIds,
} from '../../schema';
import { JobError } from '../jobs/jobs.types';
import { readPublishSnapshot } from '../publish/publish.snapshot';
import type { PublishSnapshot } from '../publish/publish.types';

export type PreviewRequest = z.infer<typeof CreatePreviewBodySchema>;
export const PreviewPayloadSchema = z.object({
    request: CreatePreviewBodySchema,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const PreviewTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

export async function readPreviewSnapshot(
    db: Queryable,
    ownerId: string,
    bookId: string,
    request: PreviewRequest,
    lock = false,
): Promise<PublishSnapshot> {
    const snapshot = await readPublishSnapshot(db, ownerId, bookId, lock);
    if (
        !snapshot ||
        snapshot.book.deleted_at ||
        snapshot.book.taken_down_at ||
        snapshot.author.status !== 'ACTIVE'
    )
        throw new JobError('PREVIEW_NOT_FOUND', 'Không tìm thấy bản nháp khả dụng.');

    const pages =
        request.scope === 'PAGE'
            ? snapshot.pages.filter((p) => p.id === request.pageId)
            : snapshot.pages;
    if (!pages.length)
        throw new JobError(
            request.scope === 'PAGE' ? 'PREVIEW_NOT_FOUND' : 'PREVIEW_EMPTY',
            'Không có trang để xem trước.',
        );
    const used = new Set<string>();
    try {
        for (const page of pages) {
            const scene = PublishedSceneSchema.parse(page.scene),
                settings = PageSettingsSchema.parse(page.settings);
            used.add(page.image_asset_id);
            for (const id of sceneAssetIds(scene, settings)) used.add(id);
            if (
                page.marker_mode === 'CUSTOM_MARKER' &&
                !page.marker_mind_public_id?.startsWith(`bookaria/${ownerId}/`)
            )
                throw new JobError('PREVIEW_INVALID_MIND', 'File .mind không thuộc tác giả.');
            if (page.marker_mode === 'BOOKARIA_MARKER') {
                const marker = snapshot.markers.find((m) => m.id === page.bookaria_marker_id);
                if (!marker?.is_active || !marker.validated_at)
                    throw new JobError('PREVIEW_INVALID_MARKER', 'Marker Bookaria chưa sẵn sàng.');
                MarkerTransformSchema.parse(page.bookaria_marker_transform);
            }
        }
    } catch (error) {
        if (error instanceof JobError) throw error;
        throw new JobError(
            'PREVIEW_INVALID_SCENE',
            'Scene, settings hoặc vị trí marker không hợp lệ.',
        );
    }
    const assets = snapshot.assets.filter((a) => used.has(a.id));
    if (
        assets.length !== used.size ||
        assets.some(
            (a) =>
                a.deleted_at ||
                a.status !== 'READY' ||
                (a.owner_id !== null && a.owner_id !== ownerId),
        )
    )
        throw new JobError(
            'PREVIEW_ASSET_UNAVAILABLE',
            'Có tài nguyên bị thiếu hoặc chưa sẵn sàng để xem trước.',
        );
    return {
        ...snapshot,
        version: 1,
        pages,
        assets,
        markers: snapshot.markers.filter((m) => pages.some((p) => p.bookaria_marker_id === m.id)),
    };
}
