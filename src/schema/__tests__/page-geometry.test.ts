import { describe, expect, it } from 'vitest';
import {
    checkMarkerPlacement,
    defaultMarkerTransform,
    markerToMm,
    pageWidthMm,
} from '../marker.schema';

describe('physical custom page geometry', () => {
    it('keeps the real marker size and margins when the custom width changes', () => {
        const page = { format: 'CUSTOM' as const, aspect: 1.5, widthMm: 300 };
        const transform = defaultMarkerTransform(page, 0);
        const mm = markerToMm(transform, page);
        expect(mm.sizeMm).toBeCloseTo(45, 2);
        expect(mm.centerXMm + mm.sizeMm / 2).toBeCloseTo(288, 1);
        expect(checkMarkerPlacement(transform, page)).toEqual([]);
        expect(checkMarkerPlacement({ ...transform, size: 30 / 300 }, page)).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: 'MARKER_TOO_SMALL' })]),
        );
    });
    it('preserves standard formats and the legacy custom width', () => {
        expect(pageWidthMm('A5', 300)).toBe(148);
        expect(pageWidthMm('CUSTOM')).toBe(210);
        expect(pageWidthMm('CUSTOM', 300)).toBe(300);
    });
});
