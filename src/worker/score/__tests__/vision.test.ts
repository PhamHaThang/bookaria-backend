import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
    analyzeMarker,
    gridCounts,
    markerSimilarity,
    renderHeatmap,
    SCORE_POLICY,
    starScore,
} from '../vision';
import { illustration } from './fixtures';

const signal = () => new AbortController().signal;

describe('marker vision', () => {
    it.each([
        [0, 0, 1],
        [39, 1, 1],
        [40, 0.25, 2],
        [100, 7 / 16, 2],
        [99, 1, 2],
        [100, 0.5, 3],
        [249, 1, 3],
        [250, 0.75, 4],
        [499, 1, 4],
        [500, 13 / 16, 4],
        [500, 14 / 16, 5],
    ])(
        'provisional boundary: %i features, %f coverage -> %i stars',
        (features, coverage, score) => {
            expect(starScore(features, coverage)).toBe(score);
        },
    );
    it('places points in a 4x4 grid including boundary coordinates', () => {
        const cells = gridCounts(
            [
                { x: 0, y: 0 },
                { x: 25, y: 25 },
                { x: 100, y: 100 },
            ],
            100,
            100,
        );
        expect(cells).toHaveLength(16);
        expect([cells[0], cells[5], cells[15]]).toEqual([1, 1, 1]);
    });
    it('scores a blank page as one star and makes an empty-cell overlay', async () => {
        const png = await sharp({
            create: { width: 640, height: 480, channels: 3, background: 'white' },
        })
            .png()
            .toBuffer();
        const result = await analyzeMarker(png, signal());
        expect(result).toMatchObject({ features: 0, coverage: 0, score: 1 });
        const overlay = await renderHeatmap(result, signal());
        const { data, info } = await sharp(overlay).raw().toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject({ width: 640, height: 480 });
        const offset = (20 * 640 + 20) * info.channels;
        expect(data[offset]).toBeGreaterThan(data[offset + 1] ?? 255);
    });
    it('extracts actual ORB descriptors and feature coverage', async () => {
        const result = await analyzeMarker(await illustration(), signal());
        expect(result.features).toBeGreaterThan(100);
        expect(result.coverage).toBeGreaterThanOrEqual(0.5);
        expect(result.descriptors.byteLength).toBe(result.features * 32);
        expect(result.score).toBeGreaterThanOrEqual(3);
        expect(result.hints.join(' ')).toContain('chưa được hiệu chuẩn');
    });
    it('does not give a good score to features concentrated in a corner', async () => {
        const result = await analyzeMarker(await illustration(7, true), signal());
        expect(result.features).toBeGreaterThan(40);
        expect(result.coverage).toBeLessThan(0.5);
        expect(result.score).toBeLessThan(3);
    });
    it('recognizes an identical image and a JPEG recompression', async () => {
        const png = await illustration();
        const a = await analyzeMarker(png, signal());
        const b = await analyzeMarker(await sharp(png).jpeg({ quality: 65 }).toBuffer(), signal());
        expect(await markerSimilarity(a, a, signal())).toBe(1);
        expect(await markerSimilarity(a, b, signal())).toBeGreaterThanOrEqual(
            SCORE_POLICY.similarThreshold,
        );
    });
    it('does not confuse unrelated illustrations', async () => {
        const a = await analyzeMarker(await illustration(7), signal());
        const b = await analyzeMarker(await illustration(917), signal());
        expect(await markerSimilarity(a, b, signal())).toBeLessThan(SCORE_POLICY.similarThreshold);
    });
    it('honors EXIF orientation and removes transparent background on white', async () => {
        const oriented = await sharp({
            create: { width: 300, height: 100, channels: 3, background: 'white' },
        })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer();
        expect(await analyzeMarker(oriented, signal())).toMatchObject({ width: 100, height: 300 });
        const transparent = await sharp({
            create: {
                width: 80,
                height: 80,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
        })
            .png()
            .toBuffer();
        const result = await analyzeMarker(transparent, signal());
        const pixels = await sharp(result.png).raw().toBuffer();
        expect([...pixels.subarray(0, 3)]).toEqual([255, 255, 255]);
    });
    it('normalizes the long edge to 1024 without stretching', async () => {
        const png = await sharp({
            create: { width: 1600, height: 800, channels: 3, background: 'white' },
        })
            .png()
            .toBuffer();
        expect(await analyzeMarker(png, signal())).toMatchObject({ width: 1024, height: 512 });
    });
    it('rejects malformed, SVG, tiny and oversized inputs', async () => {
        await expect(analyzeMarker(Buffer.from('broken'), signal())).rejects.toMatchObject({
            code: 'INVALID_MARKER_IMAGE',
        });
        await expect(
            analyzeMarker(
                Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'),
                signal(),
            ),
        ).rejects.toMatchObject({ code: 'INVALID_MARKER_IMAGE' });
        const tiny = await sharp({
            create: { width: 20, height: 20, channels: 3, background: 'white' },
        })
            .png()
            .toBuffer();
        await expect(analyzeMarker(tiny, signal())).rejects.toMatchObject({
            code: 'IMAGE_TOO_SMALL',
        });
        const outcome = await analyzeMarker(
            new Uint8Array(SCORE_POLICY.maxBytes + 1),
            signal(),
        ).then(
            () => 'unexpected',
            (err: { code: string }) => err.code,
        );
        expect(outcome).toBe('INVALID_IMAGE_SIZE');
    });
    it('checks cancellation before expensive work', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(analyzeMarker(new Uint8Array(), controller.signal)).rejects.toThrow();
    });
});
