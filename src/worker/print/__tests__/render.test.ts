import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { defaultMarkerTransform } from '../../../schema';
import { markerRect, mm, overlaps, qrRect, validatePrintLayout } from '../layout';
import { type RenderInput, renderPrintPdf } from '../render';
import { readFont, sampleImages, sampleSource } from './fixtures';

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Missing fixture');
    return value;
}

async function input(): Promise<RenderInput> {
    return {
        source: sampleSource(),
        request: { kind: 'PRINT', qrMode: 'COVER_ONLY', bleedMm: 3 },
        versionNo: 2,
        url: 'https://viewer.example.com/b/demo',
        fontBytes: await readFont(),
        signal: new AbortController().signal,
        download: await sampleImages(),
    };
}
describe('physical print layout and PDF', () => {
    it('converts A4 marker to 45 mm at 12 mm from right and bottom trim edges', () => {
        const s = sampleSource();
        const box = required(markerRect(s, required(s.pages[0])));
        expect(box.x).toBeCloseTo(153, 8);
        expect(box.y).toBeCloseTo(12, 8);
        expect(box.width).toBeCloseTo(45, 8);
        expect(box.height).toBeCloseTo(45, 8);
        expect(mm(25.4)).toBe(72);
        expect(mm(45)).toBeCloseTo(127.559055, 5);
    });
    it('preserves the editor A5 40 mm default instead of forcing 45 mm', () => {
        const s = sampleSource(148, 210),
            p = required(s.pages[0]);
        if (p.marker.mode !== 'BOOKARIA_MARKER') throw new Error('fixture');
        p.marker.transform = defaultMarkerTransform({ format: 'A5', aspect: 210 / 148 }, 1);
        const box = required(markerRect(s, p));
        expect(box.width).toBeCloseTo(40, 1);
        expect(box.x).toBeCloseTo(12, 1);
        expect(() =>
            validatePrintLayout(s, { kind: 'PRINT', qrMode: 'COVER_ONLY', bleedMm: 3 }),
        ).not.toThrow();
    });
    it('rejects small/out-of-page markers without quietly moving or scaling them', () => {
        for (const change of [{ size: 0.1 }, { x: 0.49 }, { y: 1 }]) {
            const s = sampleSource(),
                p = required(s.pages[0]);
            if (p.marker.mode !== 'BOOKARIA_MARKER') throw new Error('fixture');
            Object.assign(p.marker.transform, change);
            expect(() =>
                validatePrintLayout(s, { kind: 'PRINT', qrMode: 'COVER_ONLY', bleedMm: 0 }),
            ).toThrow(/Marker/);
        }
    });
    it('keeps QR away from markers and disallows overlays on Custom recognition images', () => {
        const s = sampleSource(),
            p = required(s.pages[0]);
        expect(overlaps(qrRect(s, p), required(markerRect(s, p)), 4)).toBe(false);
        p.marker = { mode: 'CUSTOM_MARKER' };
        expect(() =>
            validatePrintLayout(s, { kind: 'PRINT', qrMode: 'ALL_AR_PAGES', bleedMm: 3 }),
        ).toThrow(/Custom/);
        expect(() =>
            validatePrintLayout(s, { kind: 'MARKER_SHEET', qrMode: 'COVER_ONLY', bleedMm: 3 }),
        ).toThrow(/không có/);
    });
    it.each([0, 3, 10])(
        'writes distinct Media/Trim/Bleed boxes for %i mm allowance without shrinking content',
        async (bleed) => {
            const args = await input();
            args.request.bleedMm = bleed;
            const bytes = await renderPrintPdf(args),
                pdf = await PDFDocument.load(bytes),
                page = required(pdf.getPages()[2]);
            expect(pdf.getPageCount()).toBe(4); // Cover + blank verso + two content pages.
            expect(page.getTrimBox().width).toBeCloseTo(mm(210), 5);
            expect(page.getTrimBox().height).toBeCloseTo(mm(297), 5);
            expect(page.getTrimBox().x).toBeCloseTo(mm(bleed + 4), 5);
            expect(page.getBleedBox().width).toBeCloseTo(mm(210 + 2 * bleed), 5);
            expect(page.getWidth()).toBeCloseTo(mm(218 + 2 * bleed), 5);
        },
    );
    it('exports one A4 sticker page only for Bookaria markers and never downloads page images', async () => {
        const args = await input();
        args.request.kind = 'MARKER_SHEET';
        const download = vi.fn(args.download);
        args.download = download;
        const pdf = await PDFDocument.load(await renderPrintPdf(args));
        expect(pdf.getPageCount()).toBe(1);
        expect(pdf.getPages()[0]?.getWidth()).toBeCloseTo(mm(210), 5);
        expect(download).toHaveBeenCalledTimes(1);
        expect(download.mock.calls[0]?.[0].publicId).toContain('marker');
    });
    it('rejects image aspect mismatch instead of stretching recognition images', async () => {
        const args = await input();
        args.download = await sampleImages(800, 800);
        await expect(renderPrintPdf(args)).rejects.toMatchObject({ code: 'PRINT_IMAGE_ASPECT' });
    });
    it('rejects corrupt image data with a permanent business error', async () => {
        const args = await input();
        args.download = async () => Buffer.from('invalid image');
        await expect(renderPrintPdf(args)).rejects.toMatchObject({ code: 'PRINT_IMAGE_DECODE' });
    });
    it('stops before work on an aborted signal', async () => {
        const args = await input();
        args.signal = AbortSignal.abort();
        args.download = vi.fn(args.download);
        await expect(renderPrintPdf(args)).rejects.toThrow();
        expect(args.download).not.toHaveBeenCalled();
    });
});
