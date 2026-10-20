import { JobError } from '../../modules/jobs/jobs.types';
import { buildPublishCheck } from '../../modules/publish/publish.service';
import type { PublishSnapshot } from '../../modules/publish/publish.types';
import {
    AssetMetaSchema,
    type ManifestGroup,
    ManifestSchema,
    PageSettingsSchema,
    PublishedSceneSchema,
    sceneAssetIds,
} from '../../schema';
import type { PublishStorage } from './storage';

/**
 * Kiểm tra sách có còn đủ điều kiện xuất bản hay không.
 */
export function assertPublishable(snapshot: PublishSnapshot, acceptWarnings: boolean) {
    const { book, author, pages, assets, markers } = snapshot;
    if (
        book.deleted_at ||
        book.taken_down_at ||
        author.status !== 'ACTIVE' ||
        !author.email_verified_at
    )
        throw new JobError(
            'PUBLISH_UNAVAILABLE',
            'Sách hoặc tài khoản không còn đủ điều kiện xuất bản.',
        );
    const check = buildPublishCheck({
        pageAspect: Number(book.page_aspect),
        emailVerified: true,
        takenDown: false,
        pages: pages.map((p) => {
            const scene = PublishedSceneSchema.parse(p.scene);
            const settings = PageSettingsSchema.parse(p.settings);

            // Lấy asset được trang sử dụng
            const ids = sceneAssetIds(scene, settings);
            const used = [p.image_asset_id, ...ids];

            // Kiểm tra quyền và trạng thái của từng Asset
            for (const id of used) {
                const a = assets.find((a) => a.id === id);
                if (
                    !a ||
                    a.deleted_at ||
                    a.status !== 'READY' ||
                    (a.owner_id !== null && a.owner_id !== book.owner_id)
                )
                    throw new JobError(
                        'PUBLISH_ASSET_UNAVAILABLE',
                        'Có tài nguyên bị thiếu, chưa sẵn sàng hoặc không còn quyền dùng.',
                    );
            }
            // Kiểm tra file .mind của Custom Marker
            if (
                p.marker_mode === 'CUSTOM_MARKER' &&
                !p.marker_mind_public_id?.startsWith(`bookaria/${book.owner_id}/`)
            )
                throw new JobError('INVALID_MIND_OWNER', 'File .mind Custom không thuộc tác giả.');

            // Kiểm tra Marker Bookaria
            if (p.marker_mode === 'BOOKARIA_MARKER') {
                const marker = markers.find((m) => m.id === p.bookaria_marker_id);
                if (!marker?.is_active || !marker.validated_at)
                    throw new JobError(
                        'INVALID_BOOKARIA_MARKER',
                        'Marker Bookaria chưa được kiểm định hoặc đã tắt.',
                    );
            }
            const image = assets.find((a) => a.id === p.image_asset_id);
            // Chuyển dữ liệu Page => CheckPage
            return {
                id: p.id,
                orderIndex: p.order_index,
                markerMode: p.marker_mode,
                markerScore: p.marker_score,
                markerReport: p.marker_report,
                scene,
                image: image
                    ? {
                          id: image.id,
                          status: image.status,
                          sizeBytes: Number(image.meta.downloadBytes ?? image.size_bytes),
                      }
                    : null,
                assets: ids.map((id) => {
                    const a = assets.find((a) => a.id === id);
                    if (!a) throw new Error('Missing asset');
                    return {
                        id: a.id,
                        status: a.status,
                        sizeBytes: Number(a.meta.downloadBytes ?? a.size_bytes),
                    };
                }),
            };
        }),
    });
    // Xử lý Errors và Warnings
    if (check.errors.length || (check.warnings.length && !acceptWarnings))
        throw new JobError(
            'PUBLISH_BLOCKED',
            'Kiểm tra xuất bản không còn đạt. Mở publish-check rồi gửi yêu cầu mới.',
        );
}

/**
 * Tạo manifest cho bản phát hành
 * @param snapshot - Snapshot của sách và các nội dung
 * @param groups - Các nhóm asset, marker,target đã được chuẩn bị
 * @param storage - Đối tượng giúp tạo URL cho Asset
 * @param generatedAt - Thời gian tạo manifest
 */
export function makeManifest(
    snapshot: PublishSnapshot,
    groups: ManifestGroup[],
    storage: Pick<PublishStorage, 'url'>,
    generatedAt: string,
) {
    const { book, pages, assets } = snapshot;
    const used = new Set<string>();
    // Tạo URL của Asset
    const fileUrl = (a: PublishSnapshot['assets'][number]) =>
        storage.url({
            resourceType: a.resource_type,
            publicId: a.optimized_public_id ?? a.original_public_id,
            ...(a.resource_type === 'raw' ? {} : { format: a.format }),
        });

    // Duyệt từng trang để tạo manifestPages
    const manifestPages = pages.map((p) => {
        const image = assets.find((a) => a.id === p.image_asset_id);
        if (!image) throw new JobError('MISSING_PAGE_IMAGE', 'Thiếu ảnh trang.');
        const scene = PublishedSceneSchema.parse(p.scene),
            settings = PageSettingsSchema.parse(p.settings);
        for (const id of sceneAssetIds(scene, settings)) used.add(id);
        // Tìm nhóm Marker của trang
        const group = groups.find((g) => g.pageIds.includes(p.id));

        // Lấy Marker Bookaria nếu có
        const marker = snapshot.markers.find((m) => m.id === p.bookaria_marker_id);

        return {
            pageId: p.id,
            title: p.title,
            aspect: Number(book.page_aspect),
            imageUrl: fileUrl(image),
            thumbnailUrl: image.thumbnail_url ?? fileUrl(image),
            ...(group ? { group: group.group, targetIndex: group.pageIds.indexOf(p.id) } : {}),
            marker: {
                mode: p.marker_mode,
                ...(p.marker_mode === 'BOOKARIA_MARKER'
                    ? { number: marker?.number, transform: p.bookaria_marker_transform }
                    : {}),
            },
            settings,
            scene,
        };
    });
    // Tạo danh sách Asset cho Manifest
    const manifestAssets = Object.fromEntries(
        assets
            .filter((a) => used.has(a.id))
            .map((a) => [
                a.id,
                {
                    type: a.type,
                    url: fileUrl(a),
                    size: Number(a.meta.downloadBytes ?? a.size_bytes),
                    meta: AssetMetaSchema.parse(a.meta),
                },
            ]),
    );
    for (const p of pages) used.add(p.image_asset_id);

    return ManifestSchema.parse({
        schemaVersion: 1,
        bookId: book.id,
        version: snapshot.version,
        title: book.title,
        trackerEngine: 'mindar',
        generatedAt,
        targetGroups: groups,
        pages: manifestPages,
        assets: manifestAssets,
        credits: assets
            .filter((a) => used.has(a.id) && a.license && a.author_name)
            .map((a) => ({
                assetId: a.id,
                name: a.name,
                license: a.license,
                author: a.author_name,
                ...(a.source_url ? { sourceUrl: a.source_url } : {}),
            })),
    });
}
