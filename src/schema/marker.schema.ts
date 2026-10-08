import { z } from 'zod';
import { HttpUrlSchema, IdSchema } from './common.schema';
import type { PageFormat } from './enums.schema';

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
    /** Custom markers need at least this score (1-5 stars) to be published. */
    minPublishScore: 3,
    /** Pages the Viewer loads at once; one `.mind` file per group. */
    maxPagesPerGroup: 10,
} as const;

/** Printed page sizes. A custom page format uses a 210 mm wide reference page. */
export const PAGE_SIZE_MM = {
    A4: { width: 210, height: 297 },
    A5: { width: 148, height: 210 },
    SQUARE: { width: 210, height: 210 },
} as const;
export const REFERENCE_PAGE_WIDTH_MM = 210;

/** Marker score: 0 = not scored yet is stored as NULL, 1-5 stars otherwise. */
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
    ]),
    z.templateLiteral(['SIMILAR_TO:', IdSchema]),
]);
export type MarkerWarning = z.infer<typeof MarkerWarningSchema>;

/** Result of scoring a custom marker (`pages.marker_report`). */
export const MarkerReportSchema = z.object({
    /** Number of distinctive feature points. */
    features: z.int().min(0),
    /** Share of the 4x4 grid cells that contain features (0-1). */
    coverage: z.number().min(0).max(1),
    /** Overlay image that highlights empty areas. */
    heatmapUrl: HttpUrlSchema.nullable(),
    /** Other custom pages of the same book that look too similar. */
    similarPages: z.array(z.object({ pageId: IdSchema, similarity: z.number().min(0).max(1) })),
    /** Suggestions for the author, in Vietnamese. */
    hints: z.array(z.string()),
});
export type MarkerReport = z.infer<typeof MarkerReportSchema>;

// ---------------------------------------------------------------------------
// Placement geometry
// ---------------------------------------------------------------------------

export interface PageGeometry {
    format: PageFormat;
    /** Height divided by width (A4 = 1.4142). */
    aspect: number;
}
/** Page width in millimetres, used to convert page units to print sizes. */
export function pageWidthMm(format: PageFormat): number {
    return format === 'CUSTOM' ? REFERENCE_PAGE_WIDTH_MM : PAGE_SIZE_MM[format].width;
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
    const width = pageWidthMm(page.format);
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
    const width = pageWidthMm(page.format);
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
    const width = pageWidthMm(page.format);
    return {
        centerXMm: (t.x + 0.5) * width,
        centerYMm: (page.aspect / 2 - t.y) * width,
        sizeMm: t.size * width,
    };
}
