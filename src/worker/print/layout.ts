import { JobError } from '../../modules/jobs/jobs.types';
import type { PrintSource } from '../../modules/print/print.source';
import type { PrintPdfBody } from '../../schema';

export const mm = (value: number) => (value * 72) / 25.4;
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export function markerRect(
    source: PrintSource,
    page: PrintSource['pages'][number],
): Rect | undefined {
    if (page.marker.mode !== 'BOOKARIA_MARKER') return undefined;
    const t = page.marker.transform,
        size = t.size * source.widthMm;
    // PDF uses bottom-left origin, +Y up, as does the stored page coordinate system.
    return {
        x: (t.x + 0.5) * source.widthMm - size / 2,
        y: source.heightMm / 2 + t.y * source.widthMm - size / 2,
        width: size,
        height: size,
    };
}
export function overlaps(a: Rect, b: Rect, gap = 0) {
    return (
        a.x < b.x + b.width + gap &&
        a.x + a.width + gap > b.x &&
        a.y < b.y + b.height + gap &&
        a.y + a.height + gap > b.y
    );
}
export function qrRect(
    source: PrintSource,
    page: PrintSource['pages'][number],
    request?: PrintPdfBody,
): Rect {
    const custom = request?.qrPlacements?.find((p) => p.pageId === page.pageId);
    if (custom)
        return { x: custom.xMm, y: custom.yMm, width: custom.sizeMm, height: custom.sizeMm };
    const marker = markerRect(source, page),
        size = 30,
        edge = 12;
    const positions = [
        { x: edge, y: source.heightMm - edge - size },
        { x: source.widthMm - edge - size, y: source.heightMm - edge - size },
        { x: edge, y: edge },
        { x: source.widthMm - edge - size, y: edge },
    ];
    const result = positions
        .map((p) => ({ ...p, width: size, height: size }))
        .find((p) => !marker || !overlaps(p, marker, 4));
    if (!result)
        throw new JobError('PRINT_QR_SPACE', 'Không còn góc trống cho QR. Chọn COVER_ONLY.');
    return result;
}
export function coverQrRect(request: PrintPdfBody): Rect {
    const custom = request.qrPlacements?.find((p) => p.pageId === null);
    return custom
        ? { x: custom.xMm, y: custom.yMm, width: custom.sizeMm, height: custom.sizeMm }
        : { x: 14, y: 16, width: 30, height: 30 };
}
export function validatePrintLayout(source: PrintSource, request: PrintPdfBody) {
    const seen = new Set<string | null>();
    for (const placement of request.qrPlacements ?? []) {
        const page = source.pages.find((p) => p.pageId === placement.pageId);
        if (
            seen.has(placement.pageId) ||
            request.kind !== 'PRINT' ||
            (placement.pageId !== null &&
                (page?.marker.mode !== 'BOOKARIA_MARKER' || request.qrMode !== 'ALL_AR_PAGES'))
        )
            throw new JobError('PRINT_QR_TARGET', 'Vị trí QR không thuộc trang in hợp lệ.');
        seen.add(placement.pageId);
        const box = {
            x: placement.xMm,
            y: placement.yMm,
            width: placement.sizeMm,
            height: placement.sizeMm,
        };
        const marker = page && markerRect(source, page);
        if (
            placement.sizeMm < 30 ||
            placement.sizeMm > 60 ||
            Math.min(
                box.x,
                box.y,
                source.widthMm - box.x - box.width,
                source.heightMm - box.y - box.height,
            ) <
                12 - 0.001 ||
            (marker && overlaps(box, marker, 4))
        )
            throw new JobError(
                'PRINT_QR_GEOMETRY',
                'QR phải có cạnh 30–60 mm, cách mép ít nhất 12 mm và cách marker ít nhất 4 mm.',
            );
    }
    if (source.pages.length > 200 || source.heightMm > 1000)
        throw new JobError('PRINT_LIMIT', 'Giới hạn 200 trang, chiều cao tối đa 1000 mm.');
    if (source.widthMm < 80 || source.heightMm < 120)
        throw new JobError(
            'PRINT_PAGE_SIZE',
            'Hỗ trợ trang rộng ít nhất 80 mm, cao ít nhất 120 mm.',
        );
    let markers = 0;
    for (const page of source.pages) {
        const box = markerRect(source, page);
        if (box) {
            markers++;
            const tolerance = 0.03; // Existing editor rounds page units to four decimals.
            if (
                box.width < 35 - tolerance ||
                Math.min(
                    box.x,
                    box.y,
                    source.widthMm - box.x - box.width,
                    source.heightMm - box.y - box.height,
                ) <
                    12 - tolerance
            )
                throw new JobError(
                    'PRINT_MARKER_GEOMETRY',
                    'Marker phải có cạnh >=35 mm, cách mép thành phẩm >=12 mm. Sửa bản nháp rồi xuất bản lại.',
                );
            if (request.kind === 'MARKER_SHEET' && box.width > 150)
                throw new JobError(
                    'PRINT_STICKER_SIZE',
                    'Tờ tem A4 của bài hỗ trợ marker tối đa 150 mm; không tự thu nhỏ.',
                );
        }
        if (
            request.kind === 'PRINT' &&
            request.qrMode === 'ALL_AR_PAGES' &&
            page.marker.mode !== 'NONE'
        ) {
            if (page.marker.mode === 'CUSTOM_MARKER')
                throw new JobError(
                    'PRINT_CUSTOM_QR',
                    'Ảnh Custom là ảnh nhận diện; dùng COVER_ONLY để không chèn QR làm đổi ảnh.',
                );
            qrRect(source, page, request);
        }
    }
    if (request.kind === 'MARKER_SHEET' && !markers)
        throw new JobError('PRINT_NO_MARKERS', 'Sách không có marker Bookaria để tạo tem.');
}
