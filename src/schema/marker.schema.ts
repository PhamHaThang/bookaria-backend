import { z } from 'zod';
import { HttpUrlSchema, IdSchema } from './common.schema';
import type { PageFormat } from './enums.schema';
import { MarkerAnalysisMetricsSchema } from './marker-analysis.schema';

/**
 * Bookaria marker rules
 * A Bookaria marker is a numbered square printed in a corner of the page. It is the default
 * for every page; a page can switch to a custom marker (the page image itself).
 */
export const MARKER_RULES = {
    /** Default side length when printed. A5 uses 40 mm instead (see `defaultMarkerSizeMm`). */
    defaultSizeMm: 45,
    /** Smaller markers are rejected. */
    minSizeMm: 35,
    /** Distance from the marker edge to the page edge (trim margin + printer area + fingers). */
    minEdgeMarginMm: 12,
    /** The main 3D object should stay within this many marker sides of the marker (a warning). */
    stableRadiusInMarkerSides: 3,
    /** Deprecated compatibility value. Publication no longer uses a star threshold. */
    minPublishScore: 3,
    /** Pages the Viewer loads at once; one `.mind` file per group. */
    maxPagesPerGroup: 10,
} as const;

/** Printed page sizes. Legacy custom books default to a 210 mm wide reference page. */
export const PAGE_SIZE_MM = {
    A4: { width: 210, height: 297 },
    A5: { width: 148, height: 210 },
    SQUARE: { width: 210, height: 210 },
} as const;
export const REFERENCE_PAGE_WIDTH_MM = 210;
/** Stored as numeric(5,1), shared by the API and print geometry. */
export const PageWidthMmSchema = z.number().min(0.1).max(1000).multipleOf(0.1);

/** Legacy star score. New MindAR reports store NULL and carry independent `analysis` metrics. */
export const MarkerScoreSchema = z.int().min(0).max(5);

/**
 * Marker placement in page coordinates: page width = 1, origin at the page centre, +Y up.
 * `x`, `y` is the marker CENTRE and `size` is its side length.
 */
export const MarkerTransformSchema = z.object({
    x: z.number(),
    y: z.number(),
    size: z.number().positive(),
});
export type MarkerTransform = z.infer<typeof MarkerTransformSchema>;

/** A Bookaria marker as shown on a page: its number and where it sits. */
export const BookariaMarkerPlacementSchema = z.object({
    number: z.int().positive(),
    transform: MarkerTransformSchema,
});
export type BookariaMarkerPlacement = z.infer<typeof BookariaMarkerPlacementSchema>;

/** Warning codes shown on the page strip (`markerWarnings`). `SIMILAR_TO:<pageId>` names the twin page. */
export const MarkerWarningSchema = z.union([
    z.enum([
        'LOW_SCORE',
        'NOT_SCORED',
        'NO_MARKER_AVAILABLE',
        'MARKER_TOO_SMALL',
        'MARKER_NEAR_EDGE',
        'REANALYZE_REQUIRED',
        'STALE_MARKER',
        'NO_FEATURES',
        'DISTRIBUTION_LOW',
        'UNIQUENESS_LOW',
        'IMAGE_SMALL',
    ]),
    z.templateLiteral(['SIMILAR_TO:', IdSchema]),
]);
export type MarkerWarning = z.infer<typeof MarkerWarningSchema>;

/** Result of scoring a custom marker (`pages.marker_report`). */
export const MarkerReportSchema = z.object({
    /** The analyzed immutable inputs. Older reports must be analyzed again before publishing. */
    source: z
        .object({
            imageAssetId: IdSchema,
            mindPublicId: z.string().min(1).max(500),
            pageAspect: z.number().min(0.2).max(5),
            imageDigest: z.string().regex(/^[a-f0-9]{64}$/),
            mindDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .optional(),
    /** Independent MindAR/Pictarize metrics. No aggregate star score. */
    analysis: MarkerAnalysisMetricsSchema.optional(),
    /** Number of distinctive feature points. */
    features: z.int().min(0),
    /** Occupied cells: 10x10 for MindAR analysis, 4x4 for legacy ORB reports. */
    coverage: z.number().min(0).max(1),
    /** Overlay image that highlights empty areas. */
    heatmapUrl: HttpUrlSchema.nullable(),
    /** Other custom pages of the same book that look too similar. */
    similarPages: z.array(z.object({ pageId: IdSchema, similarity: z.number().min(0).max(1) })),
    /** Suggestions for the author, in Vietnamese. */
    hints: z.array(z.string()),
});
export type MarkerReport = z.infer<typeof MarkerReportSchema>;

export function markerReportStatus(
    input: unknown,
    source: { imageAssetId: string; mindPublicId: string; pageAspect: number },
) {
    if (input == null) return 'missing' as const;
    const report = MarkerReportSchema.safeParse(input);
    if (!report.success) return 'invalid' as const;
    if (!report.data.analysis || !report.data.source) return 'legacy' as const;
    const analyzed = report.data.source;
    if (
        analyzed.imageAssetId !== source.imageAssetId ||
        analyzed.mindPublicId !== source.mindPublicId ||
        Math.abs(analyzed.pageAspect - source.pageAspect) > 1e-8
    )
        return 'stale' as const;
    if (report.data.features === 0) return 'empty' as const;
    return 'ready' as const;
}

/** Quality is advisory. These thresholds never produce a five-star total or block publishing. */
export function markerQualityWarnings(
    report: MarkerReport,
): { code: 'DISTRIBUTION_LOW' | 'UNIQUENESS_LOW' | 'IMAGE_SMALL'; message: string }[] {
    const metrics = report.analysis;
    if (!metrics) return [];
    const warnings: ReturnType<typeof markerQualityWarnings> = [];
    if (metrics.distribution < 0.5)
        warnings.push({
            code: 'DISTRIBUTION_LOW',
            message:
                'Điểm đặc trưng phân bố chưa đều; nên thử quét ảnh trên điện thoại trước khi xuất bản.',
        });
    if (metrics.uniqueness < 0.5)
        warnings.push({
            code: 'UNIQUENESS_LOW',
            message:
                'Ảnh có nhiều đặc trưng lặp; nên thử quét ảnh trên điện thoại trước khi xuất bản.',
        });
    if (Math.min(metrics.sourceWidth, metrics.sourceHeight) < 1000)
        warnings.push({
            code: 'IMAGE_SMALL',
            message: 'Ảnh nhận diện có cạnh ngắn dưới 1000 px; nên dùng ảnh gốc lớn hơn.',
        });
    return warnings;
}

// ---------------------------------------------------------------------------
// Placement geometry
// ---------------------------------------------------------------------------

export interface PageGeometry {
    format: PageFormat;
    /** Height divided by width (A4 = 1.4142). */
    aspect: number;
    /** Real printed width. Omitted by older clients that use the reference width. */
    widthMm?: number | undefined;
}
/** Page width in millimetres, used to convert page units to print sizes. */
export function pageWidthMm(format: PageFormat, customWidthMm = REFERENCE_PAGE_WIDTH_MM): number {
    return format === 'CUSTOM' ? customWidthMm : PAGE_SIZE_MM[format].width;
}

export function defaultMarkerSizeMm(format: PageFormat): number {
    return format === 'A5' ? 40 : MARKER_RULES.defaultSizeMm;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Default placement: outer bottom corner, so the marker stays away from the spine.
 * Odd pages (first page = index 0) sit on the right, even pages on the left.
 */
export function defaultMarkerTransform(page: PageGeometry, orderIndex: number): MarkerTransform {
    const width = pageWidthMm(page.format, page.widthMm);
    const size = defaultMarkerSizeMm(page.format) / width;
    const margin = MARKER_RULES.minEdgeMarginMm / width;
    const side = orderIndex % 2 === 0 ? 1 : -1;
    return {
        x: round4(side * (0.5 - margin - size / 2)),
        y: round4(-(page.aspect / 2 - margin - size / 2)),
        size: round4(size),
    };
}

export interface MarkerPlacementIssue {
    code: 'MARKER_TOO_SMALL' | 'MARKER_NEAR_EDGE';
    message: string;
}

/** Tolerance in page units (about 0.02 mm), so a default placement never fails on rounding. */
const EPSILON = 1e-4;

/** Checks the size and edge-distance rules. An empty list means the placement is valid. */
export function checkMarkerPlacement(
    t: MarkerTransform,
    page: PageGeometry,
): MarkerPlacementIssue[] {
    const width = pageWidthMm(page.format, page.widthMm);
    const issues: MarkerPlacementIssue[] = [];

    if (t.size * width < MARKER_RULES.minSizeMm - EPSILON * width) {
        issues.push({
            code: 'MARKER_TOO_SMALL',
            message: `Marker nhỏ hơn ${MARKER_RULES.minSizeMm} mm nên khó quét.`,
        });
    }

    const margin = MARKER_RULES.minEdgeMarginMm / width;
    const half = t.size / 2;
    const nearEdge =
        t.x - half < -0.5 + margin - EPSILON ||
        t.x + half > 0.5 - margin + EPSILON ||
        t.y - half < -page.aspect / 2 + margin - EPSILON ||
        t.y + half > page.aspect / 2 - margin + EPSILON;
    if (nearEdge) {
        issues.push({
            code: 'MARKER_NEAR_EDGE',
            message: `Marker phải cách mép trang ít nhất ${MARKER_RULES.minEdgeMarginMm} mm.`,
        });
    }
    return issues;
}

/** Print geometry for the PDF job: centre measured from the page's top-left corner, in mm. */
export function markerToMm(t: MarkerTransform, page: PageGeometry) {
    const width = pageWidthMm(page.format, page.widthMm);
    return {
        centerXMm: (t.x + 0.5) * width,
        centerYMm: (page.aspect / 2 - t.y) * width,
        sizeMm: t.size * width,
    };
}

/** A4 cut-out sheets. All coordinates use millimetres from the top-left. */
export const MARKER_STICKER_SHEET = {
    widthMm: 210,
    heightMm: 297,
    marginMm: 14,
    gapMm: 6,
    contentTopMm: 68,
    contentBottomMm: 274,
    paddingMm: 4,
    cutMarginMm: 1,
    labelHeightMm: 11,
    qr: { xMm: 158, yMm: 14, sizeMm: 34 },
    qrFrame: { xMm: 157, yMm: 13, widthMm: 36, heightMm: 36 },
} as const;
export type MarkerStickerItem = {
    pageId: string;
    pageNumber: number;
    markerNumber: number;
    sizeMm: number;
};
export function layoutMarkerStickerSheets<T extends MarkerStickerItem>(markers: readonly T[]) {
    type Item = T & {
        xMm: number;
        yMm: number;
        widthMm: number;
        heightMm: number;
        imageXMm: number;
        imageYMm: number;
    };
    const sheets: { items: Item[] }[] = [];
    const c = MARKER_STICKER_SHEET;
    let x = c.marginMm,
        y: number = c.contentTopMm,
        rowHeight = 0;
    for (const marker of markers) {
        if (!Number.isFinite(marker.sizeMm) || marker.sizeMm < 35 - 0.03 || marker.sizeMm > 150)
            throw new RangeError(
                'Tờ tem hỗ trợ marker có cạnh từ 35 đến 150 mm. Không tự co giãn marker.',
            );
        const width = Math.max(54, marker.sizeMm + 2 * c.paddingMm);
        const height = marker.sizeMm + 2 * c.paddingMm + c.labelHeightMm;
        if (x + width > c.widthMm - c.marginMm) {
            x = c.marginMm;
            y += rowHeight + c.gapMm;
            rowHeight = 0;
        }
        if (!sheets.length || y + height > c.contentBottomMm) {
            sheets.push({ items: [] });
            x = c.marginMm;
            y = c.contentTopMm;
            rowHeight = 0;
        }
        sheets[sheets.length - 1]?.items.push({
            ...marker,
            xMm: x,
            yMm: y,
            widthMm: width,
            heightMm: height,
            imageXMm: x + (width - marker.sizeMm) / 2,
            imageYMm: y + c.paddingMm,
        });
        x += width + c.gapMm;
        rowHeight = Math.max(rowHeight, height);
    }
    return sheets;
}
