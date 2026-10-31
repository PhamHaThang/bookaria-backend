import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
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
    it('prints the uploaded cover centered with its original aspect and uses a vector logo when absent', async () => {
        const args = await input();
        const image = await sharp({
            create: { width: 1200, height: 600, channels: 3, background: '#30a7c2' },
        })
            .png()
            .toBuffer();
        const download = args.download;
        args.source.cover = { publicId: 'fixture/cover', format: 'png' };
        args.download = vi.fn(async (file, signal) =>
            file.publicId === 'fixture/cover' ? image : download(file, signal),
        );
        const pdf = await PDFDocument.load(await renderPrintPdf(args));
        const cover = required(pdf.getPages()[0]);
        const resources = required(cover.node.Resources());
        expect(resources.lookup(PDFName.of('XObject'), PDFDict).entries().length).toBe(1);
        const content = pdf.context
            .lookup(cover.node.Contents(), PDFArray)
            .asArray()
            .map((ref) => {
                const stream = pdf.context.lookup(ref);
                if (!(stream instanceof PDFRawStream))
                    throw new Error('Missing PDF content stream');
                return Buffer.from(decodePDFRawStream(stream).decode()).toString();
            })
            .join('');
        // 1200:600 fits the 210 x 297 mm trim as 210 x 105 mm, centered vertically.
        expect(content).toContain(`${mm(210)} 0 0 ${mm(105)} 0 0 cm`);
        expect(content).toContain(`1 0 0 1 ${mm(7)} ${mm(7 + (297 - 105) / 2)} cm`);
        expect(args.download).toHaveBeenCalledWith(args.source.cover, args.signal);
        const unchanged = required(pdf.getPages()[2]).getTrimBox();
        expect(unchanged.width).toBeCloseTo(mm(210));
        args.source.cover = null;
        const fallback = await PDFDocument.load(await renderPrintPdf(args));
        const fallbackCover = required(fallback.getPages()[0]);
        expect(
            required(fallbackCover.node.Resources())
                .lookup(PDFName.of('XObject'), PDFDict)
                .entries().length,
        ).toBe(0);
    });
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
    it('uses requested QR positions and rejects collisions, duplicates and inactive targets', async () => {
        const args = await input();
        args.request.qrMode = 'ALL_AR_PAGES';
        const page = required(args.source.pages[0]);
        args.request.qrPlacements = [{ pageId: page.pageId, xMm: 20, yMm: 100, sizeMm: 40 }];
        expect(qrRect(args.source, page, args.request)).toEqual({
            x: 20,
            y: 100,
            width: 40,
            height: 40,
        });
        expect((await renderPrintPdf(args)).length).toBeGreaterThan(1000);
        for (const placements of [
            [{ pageId: page.pageId, xMm: 160, yMm: 12, sizeMm: 35 }],
            [{ pageId: page.pageId, xMm: 1, yMm: 100, sizeMm: 30 }],
            [{ pageId: page.pageId, xMm: 20, yMm: 100, sizeMm: 29 }],
            [
                { pageId: page.pageId, xMm: 20, yMm: 100, sizeMm: 40 },
                { pageId: page.pageId, xMm: 20, yMm: 100, sizeMm: 40 },
            ],
            [
                { pageId: page.pageId, xMm: 20, yMm: 100, sizeMm: 40 },
                { pageId: required(args.source.pages[1]).pageId, xMm: 20, yMm: 100, sizeMm: 40 },
            ],
        ]) {
            args.request.qrPlacements = placements;
            expect(() => validatePrintLayout(args.source, args.request)).toThrow();
        }
        args.request.qrPlacements = [{ pageId: null, xMm: 80, yMm: 80, sizeMm: 40 }];
        expect(() => validatePrintLayout(args.source, args.request)).not.toThrow();
        required(args.request.qrPlacements[0]).yMm = 280;
        expect(() => validatePrintLayout(args.source, args.request)).toThrow(/QR/);
    });
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
