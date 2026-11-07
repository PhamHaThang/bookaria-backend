import { describe, expect, it } from 'vitest';
import { analyzeMindarLevel, MarkerImageAnalysisSchema, MarkerReportSchema } from '../../../schema';
import { analyzeCompiledMarker } from '../pictarize';
import { compiledFixture } from './fixtures';

const feature = (x: number, y: number, value = 0) => ({
    x,
    y,
    scale: 1,
    descriptors: Array(21).fill(value),
});
const level = (
    maximaPoints: ReturnType<typeof feature>[] = [],
    minimaPoints: ReturnType<typeof feature>[] = [],
) => ({ width: 800, height: 800, maximaPoints, minimaPoints });
const signal = () => new AbortController().signal;

describe('Pictarize-style MindAR analysis', () => {
    it('returns three independent measurements and no five-star total', () => {
        const result = analyzeMindarLevel(
            level([feature(10, 10), feature(90, 90, 0xffffffff)]),
            1600,
            1600,
        );
        expect(result).toMatchObject({
            features: 2,
            coverage: 0.02,
            analysis: { distribution: 0.02, uniqueness: 1, dimension: 1 },
        });
        expect(result.cells).toHaveLength(100);
        expect(result).not.toHaveProperty('score');
        expect(MarkerImageAnalysisSchema.parse(result)).toEqual(result);
    });
    it('counts occupied cells instead of feature density', () => {
        const result = analyzeMindarLevel(
            level([feature(0, 0), feature(1, 1), feature(799, 799)]),
            800,
            800,
        );
        expect(result.cells[0]).toBe(2);
        expect(result.cells[99]).toBe(1);
        expect(result.analysis.distribution).toBe(0.02);
    });
    it('detects repeated binary descriptors within polarity only', () => {
        const point = feature(10, 10);
        expect(
            analyzeMindarLevel(level([point, feature(100, 100)], []), 800, 800).analysis.uniqueness,
        ).toBe(0);
        expect(analyzeMindarLevel(level([point], [point]), 800, 800).analysis.uniqueness).toBe(1);
    });
    it('uses a strict Hamming threshold of 50 bits', () => {
        const base = feature(10, 10);
        const other = feature(100, 100);
        other.descriptors[0] = 0xffffffff;
        other.descriptors[1] = (1 << 18) - 1;
        expect(analyzeMindarLevel(level([base, other]), 800, 800).analysis.uniqueness).toBe(1);
        other.descriptors[1] = (1 << 17) - 1;
        expect(analyzeMindarLevel(level([base, other]), 800, 800).analysis.uniqueness).toBe(0);
    });
    it.each([
        [199, 199, 0.5],
        [200, 200, 0.6],
        [800, 800, 0.9],
        [1000, 1000, 1],
        [1000, 1250, 1],
        [1000, 1251, 0.8],
    ])('uses original dimensions %ix%i -> %f', (width, height, dimension) => {
        expect(analyzeMindarLevel(level(), width, height).analysis.dimension).toBe(dimension);
    });
    it('handles empty and singleton targets without NaN', () => {
        expect(analyzeMindarLevel(level(), 1000, 1000).analysis.uniqueness).toBe(0);
        expect(analyzeMindarLevel(level([feature(10, 10)]), 1000, 1000).analysis.uniqueness).toBe(
            1,
        );
    });
    it('rejects corrupt data, invalid coordinates, oversized feature lists and cancellation', () => {
        expect(() => analyzeMindarLevel(level([feature(800, 1)]), 800, 800)).toThrow();
        expect(() =>
            analyzeMindarLevel(level(Array(2049).fill(feature(1, 1))), 800, 800),
        ).toThrow();
        expect(() => analyzeCompiledMarker(Buffer.from('bad'), 800, 800, signal())).toThrow();
        const controller = new AbortController();
        controller.abort();
        expect(() =>
            analyzeCompiledMarker(compiledFixture(), 800, 800, controller.signal),
        ).toThrow();
    });
    it('reads existing compiled features without running the compiler', () => {
        expect(analyzeCompiledMarker(compiledFixture(), 1600, 1600, signal())).toMatchObject({
            features: 180,
            analysis: { distribution: 1, dimension: 1 },
        });
    });
    it('keeps legacy reports valid and retains new metrics in saved reports', () => {
        const legacy = { features: 0, coverage: 0, heatmapUrl: null, similarPages: [], hints: [] };
        expect(MarkerReportSchema.parse(legacy)).toEqual(legacy);
        const { analysis } = analyzeMindarLevel(level(), 1000, 1000);
        expect(MarkerReportSchema.parse({ ...legacy, analysis }).analysis).toEqual(analysis);
    });
});
