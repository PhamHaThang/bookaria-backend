import type { Queryable } from '../../db';
import {
    defaultMarkerTransform,
    MARKER_RULES,
    MarkerTransformSchema,
    type PageGeometry,
    type PageImageReplacement,
    pageWidthMm,
} from '../../schema';
import { AppError, fieldError } from '../../utils';
import { pagesRepository } from './pages.repository';

/** Called under the book lock. The whole replacement batch commits with the new geometry. */
export async function resizePageImages(
    db: Queryable,
    userId: string,
    bookId: string,
    replacements: PageImageReplacement[],
    allowAlreadyApplied = false,
) {
    if (await pagesRepository.hasOpenBookJob(db, bookId)) throw new AppError('JOB_IN_PROGRESS');
    const pages = await pagesRepository.getPages(db, bookId);
    const byId = new Map(replacements.map((value) => [value.pageId, value]));
    if (
        byId.size !== replacements.length ||
        pages.length !== byId.size ||
        pages.some((page) => !byId.has(page.id))
    )
        throw fieldError('pageImages', 'Danh sách trang đã thay đổi. Tải lại sách rồi thử lại.');
    // A lost response may safely retry the exact same, already committed replacement batch.
    if (
        allowAlreadyApplied &&
        pages.every(
            (page) =>
                page.image_asset_id === byId.get(page.id)?.expectedImageAssetId &&
                page.marker_mode === byId.get(page.id)?.expectedMarkerMode &&
                (page.marker_mode !== 'CUSTOM_MARKER' ||
                    page.marker_mind_public_id === byId.get(page.id)?.markerMindPublicId),
        )
    )
        return;
    if (allowAlreadyApplied)
        throw new AppError(
            'REVISION_CONFLICT',
            'Ảnh hoặc marker đã được sửa ở nơi khác. Tải lại sách.',
        );
    for (const page of pages) {
        const next = byId.get(page.id) as PageImageReplacement;
        if (
            next.expectedImageAssetId !== page.image_asset_id ||
            next.expectedMarkerMode !== page.marker_mode
        )
            throw new AppError(
                'REVISION_CONFLICT',
                'Ảnh hoặc marker đã được sửa ở nơi khác. Tải lại sách.',
            );
        if (page.marker_mode === 'CUSTOM_MARKER') {
            if (!next.markerMindPublicId)
                throw fieldError('pageImages', 'Thiếu dữ liệu nhận diện của ảnh trang mới.');
            if (await pagesRepository.hasOpenScoreJob(db, page.id))
                throw new AppError('JOB_IN_PROGRESS');
        }
    }
    for (const page of pages) {
        const next = byId.get(page.id) as PageImageReplacement;
        if (page.marker_mode === 'CUSTOM_MARKER') {
            await pagesRepository.setCustomMarkerFile(
                db,
                page.id,
                next.markerMindPublicId as string,
            );
            await pagesRepository.insertScoreJob(db, page.id, userId);
        }
    }
}

/** Keep the printed marker's physical size and its relative location when paper dimensions change. */
export async function resizeBookariaMarkers(
    db: Queryable,
    bookId: string,
    before: PageGeometry,
    after: PageGeometry,
) {
    const oldWidth = pageWidthMm(before.format, before.widthMm);
    const width = pageWidthMm(after.format, after.widthMm);
    for (const page of await pagesRepository.getPages(db, bookId)) {
        if (page.marker_mode !== 'BOOKARIA_MARKER') continue;
        const old =
            MarkerTransformSchema.safeParse(page.marker_transform).data ??
            defaultMarkerTransform(before, page.order_index);
        const size = Math.max(MARKER_RULES.minSizeMm / width, (old.size * oldWidth) / width);
        const margin = MARKER_RULES.minEdgeMarginMm / width + size / 2;
        const maxX = 0.5 - margin,
            maxY = after.aspect / 2 - margin;
        if (maxX < 0 || maxY < 0)
            throw fieldError(
                'pageWidthMm',
                'Khổ trang quá nhỏ để đặt marker hiện tại. Hãy tăng kích thước trang.',
            );
        await pagesRepository.setMarkerTransform(db, page.id, {
            size,
            x: Math.max(-maxX, Math.min(maxX, old.x)),
            y: Math.max(-maxY, Math.min(maxY, (old.y * after.aspect) / before.aspect)),
        });
    }
}
