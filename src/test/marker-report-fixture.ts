import { createHash } from 'node:crypto';
import type { MarkerReport } from '../schema';
// Match books.page_aspect numeric(6,4), including its default rounding.
export const DATABASE_A4_ASPECT = 14142 / 10000;

/** Synthetic analysis certificate for publication tests; never used for camera calibration. */
export function markerReportFixture(
    imageAssetId: string,
    mindPublicId: string,
    pageAspect = Math.SQRT2,
    mind: Uint8Array | string = mindPublicId,
): MarkerReport {
    const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
    return {
        source: {
            imageAssetId,
            mindPublicId,
            pageAspect,
            imageDigest: digest(imageAssetId),
            mindDigest: digest(mind),
        },
        analysis: {
            policyVersion: 'mindar-pictarize-v1',
            distribution: 0.8,
            uniqueness: 0.8,
            dimension: 0.8,
            sourceWidth: 1600,
            sourceHeight: 2263,
        },
        features: 180,
        coverage: 0.8,
        heatmapUrl: null,
        similarPages: [],
        hints: [],
    };
}
