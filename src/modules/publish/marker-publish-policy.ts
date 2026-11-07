import {
    checkMarkerPlacement,
    MarkerReportSchema,
    MarkerTransformSchema,
    markerQualityWarnings,
    markerReportStatus,
    type PublishError,
    type PublishWarning,
} from '../../schema';
import type { CheckInput } from './publish.types';

/** One policy for API preflight and the worker's immutable publication snapshot. */
export function checkPublicationMarkers(input: CheckInput) {
    const errors: PublishError[] = [],
        warnings: PublishWarning[] = [];
    const identities = new Map<string, CheckInput['pages'][number]>();
    const duplicatePairs = new Set<string>();
    const similarPairs = new Set<string>();
    const pageIds = new Set(
        input.pages.filter((page) => page.markerMode === 'CUSTOM_MARKER').map((page) => page.id),
    );
    for (const page of input.pages) {
        if (page.markerMode === 'NONE') continue;
        const label = `Trang ${page.orderIndex + 1}`;
        const fail = (code: PublishError['code'], message: string) =>
            errors.push({ code, pageId: page.id, message: `${label}: ${message}` });
        const identity = (key: string) => {
            const peer = identities.get(key);
            if (!peer) {
                identities.set(key, page);
                return;
            }
            if (peer.id === page.id) return;
            const pair = [peer.id, page.id].sort().join(':');
            if (duplicatePairs.has(pair)) return;
            duplicatePairs.add(pair);
            errors.push({
                code: 'MARKER_DUPLICATE',
                pageId: page.id,
                otherPageId: peer.id,
                message: `${label} dùng cùng marker với trang ${peer.orderIndex + 1}. Chọn ảnh hoặc marker khác để nhận diện đúng trang.`,
            });
        };
        if (page.markerMode === 'BOOKARIA_MARKER') {
            const marker = page.bookariaMarker;
            if (!marker?.mindPublicId) {
                fail(
                    'MARKER_MISSING',
                    'Chưa có marker Bookaria khả dụng. Chọn lại marker hoặc tắt AR cho trang.',
                );
                continue;
            }
            identity(`mind:${marker.mindPublicId}`);
            if (!marker.active || !marker.validated)
                fail(
                    'MARKER_INVALID',
                    'Marker Bookaria chưa được kiểm định hoặc đã tắt. Chọn lại marker.',
                );
            const placement = MarkerTransformSchema.safeParse(marker.transform);
            if (!placement.success)
                fail('MARKER_INVALID', 'Vị trí hoặc kích thước marker chưa hợp lệ.');
            else
                for (const issue of checkMarkerPlacement(placement.data, {
                    format: input.pageFormat || 'A4',
                    aspect: input.pageAspect,
                    widthMm: input.pageWidthMm,
                }))
                    fail('MARKER_INVALID', issue.message);
            continue;
        }
        if (!page.markerMindPublicId) {
            fail(
                'MARKER_MISSING',
                'Thiếu tệp .mind. Áp dụng lại ảnh nhận diện để biên dịch marker.',
            );
            continue;
        }
        identity(`mind:${page.markerMindPublicId}`);
        if (page.markerJobStatus === 'QUEUED' || page.markerJobStatus === 'RUNNING') {
            fail(
                'MARKER_PROCESSING',
                'Đang phân tích marker. Đợi hoàn tất rồi kiểm tra xuất bản lại.',
            );
            continue;
        }
        if (page.markerJobStatus === 'FAILED' || page.markerJobStatus === 'CANCELLED') {
            fail(
                'MARKER_FAILED',
                'Phân tích marker chưa thành công. Mở AR Marker để kiểm tra và đánh giá lại.',
            );
            continue;
        }
        if (!page.image) continue; // The shared page check reports the missing image.
        const status = markerReportStatus(page.markerReport, {
            imageAssetId: page.image.id,
            mindPublicId: page.markerMindPublicId,
            pageAspect: input.pageAspect,
        });
        const failure = {
            missing: [
                'PAGE_NOT_SCORED',
                'Chưa phân tích ảnh nhận diện. Mở AR Marker và chọn Đánh giá lại.',
            ],
            invalid: [
                'MARKER_INVALID',
                'Báo cáo marker không hợp lệ. Biên dịch và đánh giá lại ảnh nhận diện.',
            ],
            legacy: [
                'MARKER_REANALYZE_REQUIRED',
                'Báo cáo marker dùng định dạng cũ. Đánh giá lại để kiểm tra ảnh và tệp marker hiện tại.',
            ],
            stale: [
                'MARKER_STALE',
                'Ảnh, khổ trang hoặc tệp marker đã thay đổi. Áp dụng lại ảnh nhận diện và đánh giá lại.',
            ],
            empty: [
                'MARKER_NO_FEATURES',
                'Không tìm thấy điểm đặc trưng để nhận diện. Chọn ảnh có chi tiết rõ hơn và biên dịch lại.',
            ],
        } as const;
        if (status !== 'ready') {
            fail(failure[status][0], failure[status][1]);
            continue;
        }
        const report = MarkerReportSchema.parse(page.markerReport);
        if (report.source) {
            identity(`image:${report.source.imageDigest}`);
            identity(`compiled:${report.source.mindDigest}`);
        }
        for (const warning of markerQualityWarnings(report))
            warnings.push({
                code: `MARKER_${warning.code}`,
                pageId: page.id,
                message: `${label}: ${warning.message}`,
            });
        for (const peer of report.similarPages) {
            const pair = [page.id, peer.pageId].sort().join(':');
            if (peer.pageId === page.id || !pageIds.has(peer.pageId) || similarPairs.has(pair))
                continue;
            similarPairs.add(pair);
            warnings.push({
                code: 'PAGE_SIMILAR',
                pageId: page.id,
                otherPageId: peer.pageId,
                message: `${label} dễ bị nhận nhầm với một trang khác. Nên thử quét cả hai trang.`,
            });
        }
    }
    return { errors, warnings };
}
