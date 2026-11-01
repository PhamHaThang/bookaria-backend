import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { JobError } from '../../modules/jobs/jobs.types';
import type { PrintFile, PrintSource } from '../../modules/print/print.source';
import { layoutMarkerStickerSheets, MARKER_STICKER_SHEET, type PrintPdfBody } from '../../schema';
import { MAX_OUTPUT_BYTES } from '../publish/mind';
import { coverQrRect, markerRect, mm, qrRect, type Rect, validatePrintLayout } from './layout';
import { MAX_IMAGE_BYTES } from './storage';

export interface RenderInput {
    source: PrintSource;
    request: PrintPdfBody;
    versionNo: number;
    url: string;
    fontBytes: Uint8Array;
    signal: AbortSignal;
    download: (file: PrintFile, signal: AbortSignal) => Promise<Buffer>;
    progress?: (percent: number) => Promise<void>;
}
/** Coordinates in the drawing helpers are millimetres, with a PDF bottom-left origin. */
export async function renderPrintPdf(input: RenderInput): Promise<Buffer> {
    const { source, request, signal } = input;
    validatePrintLayout(source, request);
    signal.throwIfAborted();
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(input.fontBytes, { subset: true });
    const supportedCharacters = new Set(font.getCharacterSet());
    doc.setTitle(`${source.title} - ${request.kind} - v${input.versionNo}`);
    doc.setCreator('Bookaria WK-07');
    doc.setSubject('Print at Actual size / 100%. Do not fit to page.');
    const black = rgb(0.08, 0.1, 0.12),
        grey = rgb(0.35, 0.38, 0.42);
    function text(page: PDFPage, value: string, x: number, y: number, size = 10, color = black) {
        for (const character of value.normalize('NFC'))
            if (!supportedCharacters.has(character.codePointAt(0) as number))
                throw new JobError(
                    'PRINT_FONT_GLYPH',
                    'Tiêu đề có ký tự ngoài font in; dùng ký tự được Noto Sans hỗ trợ.',
                );
        page.drawText(value.normalize('NFC'), { x: mm(x), y: mm(y), size, font, color });
    }
    function rect(page: PDFPage, box: Rect, color = rgb(1, 1, 1)) {
        page.drawRectangle({
            x: mm(box.x),
            y: mm(box.y),
            width: mm(box.width),
            height: mm(box.height),
            color,
        });
    }
    function line(page: PDFPage, x1: number, y1: number, x2: number, y2: number) {
        page.drawLine({
            start: { x: mm(x1), y: mm(y1) },
            end: { x: mm(x2), y: mm(y2) },
            thickness: 0.35,
            color: grey,
        });
    }
    function qr(page: PDFPage, box: Rect) {
        const matrix = QRCode.create(input.url, { errorCorrectionLevel: 'M' }).modules;
        const unit = box.width / (matrix.size + 8);
        if (unit < 0.3)
            throw new JobError(
                'PRINT_QR_DENSITY',
                'URL quá dài để in QR rõ nét ở cỡ 30 mm; dùng domain ngắn hơn.',
            );
        rect(page, box);
        for (let y = 0; y < matrix.size; y++)
            for (let x = 0; x < matrix.size; x++)
                if (matrix.get(y, x))
                    rect(
                        page,
                        {
                            x: box.x + (x + 4) * unit,
                            y: box.y + box.height - (y + 5) * unit,
                            width: unit,
                            height: unit,
                        },
                        rgb(0, 0, 0),
                    );
    }
    function sheet(width = source.widthMm, height = source.heightMm) {
        const offset = request.bleedMm + 4,
            page = doc.addPage([mm(width + 2 * offset), mm(height + 2 * offset)]);
        page.setTrimBox(mm(offset), mm(offset), mm(width), mm(height));
        page.setBleedBox(
            mm(4),
            mm(4),
            mm(width + 2 * request.bleedMm),
            mm(height + 2 * request.bleedMm),
        );
        for (const x of [offset, offset + width]) {
            line(page, x, 1, x, 3);
            line(page, x, height + 2 * offset - 3, x, height + 2 * offset - 1);
        }
        for (const y of [offset, offset + height]) {
            line(page, 1, y, 3, y);
            line(page, width + 2 * offset - 3, y, width + 2 * offset - 1, y);
        }
        return { page, offset };
    }
    let total = 0;
    const cache = new Map<string, Promise<{ png: Buffer; width: number; height: number }>>();
    async function image(file: PrintFile) {
        const key = JSON.stringify(file);
        let pending = cache.get(key);
        if (!pending) {
            pending = (async () => {
                signal.throwIfAborted();
                const bytes = await input.download(file, signal);
                total += bytes.length;
                if (bytes.length > MAX_IMAGE_BYTES || total > 100 * 1024 * 1024)
                    throw new JobError(
                        'PRINT_INPUT_SIZE',
                        'Giới hạn ảnh: 20 MiB/file, 100 MiB/job.',
                    );
                try {
                    const { data, info } = await sharp(bytes, {
                        limitInputPixels: 40_000_000,
                        animated: false,
                    })
                        .rotate()
                        .flatten({ background: '#fff' })
                        .png()
                        .toBuffer({ resolveWithObject: true });
                    if (data.length > MAX_IMAGE_BYTES)
                        throw new JobError('PRINT_IMAGE_SIZE', 'Ảnh PNG sau giải mã vượt 20 MiB.');
                    return { png: data, width: info.width, height: info.height };
                } catch (error) {
                    if (error instanceof JobError) throw error;
                    throw new JobError(
                        'PRINT_IMAGE_DECODE',
                        'Ảnh không hợp lệ hoặc vượt giới hạn pixel.',
                    );
                }
            })();
            cache.set(key, pending);
        }
        return pending;
    }
    const printMarkers = new Map<string, Promise<Buffer>>();
    async function drawImage(page: PDFPage, file: PrintFile, box: Rect, square = false) {
        const value = await image(file);
        if (
            Math.abs(value.height / value.width - box.height / box.width) >
            0.01 * (box.height / box.width)
        )
            throw new JobError(
                'PRINT_IMAGE_ASPECT',
                square
                    ? 'Ảnh marker phải vuông.'
                    : 'Tỷ lệ ảnh trang không khớp khổ sách; không tự crop hoặc kéo méo ảnh nhận diện.',
            );
        let bytes = value.png;
        if (square) {
            // Keep the physical size unchanged; 300 dpi avoids embedding oversized source artwork.
            const pixels = Math.ceil((box.width / 25.4) * 300);
            const key = `${JSON.stringify(file)}:${pixels}`;
            let pending = printMarkers.get(key);
            if (!pending) {
                pending = sharp(value.png)
                    .resize({ width: pixels, withoutEnlargement: true })
                    .png({ compressionLevel: 9, adaptiveFiltering: true })
                    .toBuffer();
                printMarkers.set(key, pending);
            }
            bytes = await pending;
        }
        const embedded = await doc.embedPng(bytes);
        page.drawImage(embedded, {
            x: mm(box.x),
            y: mm(box.y),
            width: mm(box.width),
            height: mm(box.height),
        });
    }
    if (request.kind === 'PRINT') {
        const { page: cover, offset: o } = sheet();
        if (source.cover) {
            const value = await image(source.cover);
            const factor = Math.min(source.widthMm / value.width, source.heightMm / value.height);
            const width = value.width * factor,
                height = value.height * factor;
            const embedded = await doc.embedPng(value.png);
            cover.drawImage(embedded, {
                x: mm(o + (source.widthMm - width) / 2),
                y: mm(o + (source.heightMm - height) / 2),
                width: mm(width),
                height: mm(height),
            });
        } else {
            // Same proportions as the existing Bookaria symbol (506 x 256 viewBox).
            const factor = (source.widthMm * 0.4) / 506;
            for (const center of [-125, 125]) {
                const x = mm(o + source.widthMm / 2 + center * factor),
                    y = mm(o + source.heightMm / 2);
                for (const [radius, color] of [
                    [110, rgb(17 / 255, 17 / 255, 17 / 255)],
                    [88, rgb(1, 1, 1)],
                    [30, rgb(17 / 255, 17 / 255, 17 / 255)],
                ] as const)
                    cover.drawEllipse({
                        x,
                        y,
                        xScale: mm(radius * factor),
                        yScale: mm(radius * factor),
                        color,
                    });
            }
        }
        const coverBox = coverQrRect(request);
        qr(cover, { ...coverBox, x: o + coverBox.x, y: o + coverBox.y });
        // A blank verso keeps original content page 1 on the recto when printing duplex.
        sheet();
        for (const [index, p] of source.pages.entries()) {
            signal.throwIfAborted();
            const { page, offset } = sheet();
            await drawImage(page, p.image, {
                x: offset,
                y: offset,
                width: source.widthMm,
                height: source.heightMm,
            });
            const marker = markerRect(source, p);
            if (marker && p.marker.mode === 'BOOKARIA_MARKER')
                await drawImage(
                    page,
                    p.marker.image,
                    { ...marker, x: marker.x + offset, y: marker.y + offset },
                    true,
                );
            if (request.qrMode === 'ALL_AR_PAGES' && p.marker.mode !== 'NONE') {
                const q = qrRect(source, p, request);
                qr(page, { ...q, x: q.x + offset, y: q.y + offset });
            }
            await input.progress?.(10 + Math.round((75 * (index + 1)) / source.pages.length));
        }
    } else {
        const c = MARKER_STICKER_SHEET;
        const sheets = layoutMarkerStickerSheets(
            source.pages.flatMap((p, index) => {
                if (p.marker.mode !== 'BOOKARIA_MARKER') return [];
                return [
                    {
                        pageId: p.pageId,
                        pageNumber: index + 1,
                        markerNumber: p.marker.number,
                        sizeMm: (markerRect(source, p) as Rect).width,
                        image: p.marker.image,
                    },
                ];
            }),
        );
        const cut = (page: PDFPage, x: number, top: number, width: number, height: number) => {
            page.drawRectangle({
                x: mm(x),
                y: mm(c.heightMm - top - height),
                width: mm(width),
                height: mm(height),
                borderColor: rgb(0.66, 0.66, 0.66),
                borderWidth: 0.5,
                borderDashArray: [mm(1.2), mm(1)],
            });
        };
        for (const [sheetIndex, sheet] of sheets.entries()) {
            signal.throwIfAborted();
            const page = doc.addPage([mm(c.widthMm), mm(c.heightMm)]);
            // Vector Bookaria symbol; keep the print header sharp at any resolution.
            for (const x of [18, 26]) {
                for (const [radius, color] of [
                    [3.6, black],
                    [2.8, rgb(1, 1, 1)],
                    [0.95, black],
                ] as const)
                    page.drawEllipse({
                        x: mm(x),
                        y: mm(c.heightMm - 19.5),
                        xScale: mm(radius),
                        yScale: mm(radius),
                        color,
                    });
            }
            text(page, 'Bookaria', 34, c.heightMm - 22, 18);
            const titleLines = wrap(source.title, font, 12, mm(130));
            for (const [i, value] of titleLines.slice(0, 2).entries()) {
                let line = value;
                if (i === 1 && titleLines.length > 2) {
                    while (line && font.widthOfTextAtSize(`${line}…`, 12) > mm(130))
                        line = line.slice(0, -1);
                    line += '…';
                }
                text(page, line, 14, c.heightMm - 37 - i * 5.5, 12);
            }
            text(
                page,
                'Cắt theo nét đứt. Dán QR lên bìa, marker vào trang tương ứng.',
                14,
                c.heightMm - 55,
                8.5,
                grey,
            );
            cut(page, c.qrFrame.xMm, c.qrFrame.yMm, c.qrFrame.widthMm, c.qrFrame.heightMm);
            qr(page, {
                x: c.qr.xMm,
                y: c.heightMm - c.qr.yMm - c.qr.sizeMm,
                width: c.qr.sizeMm,
                height: c.qr.sizeMm,
            });
            const centered = (value: string, top: number, size: number, center: number) =>
                text(
                    page,
                    value,
                    center - font.widthOfTextAtSize(value, size) / mm(2),
                    c.heightMm - top,
                    size,
                );
            centered('Quét để mở sách', 53, 8, 175);
            centered('Dán lên bìa sách', 58, 7, 175);
            for (const item of sheet.items) {
                cut(
                    page,
                    item.imageXMm - c.cutMarginMm,
                    item.imageYMm - c.cutMarginMm,
                    item.sizeMm + 2 * c.cutMarginMm,
                    item.sizeMm + 2 * c.cutMarginMm,
                );
                await drawImage(
                    page,
                    item.image,
                    {
                        x: item.imageXMm,
                        y: c.heightMm - item.imageYMm - item.sizeMm,
                        width: item.sizeMm,
                        height: item.sizeMm,
                    },
                    true,
                );
                const center = item.xMm + item.widthMm / 2;
                centered(`Trang ${item.pageNumber}`, item.imageYMm + item.sizeMm + 5, 8.5, center);
                centered(
                    `Cạnh ${Number(item.sizeMm.toFixed(1))} mm`,
                    item.imageYMm + item.sizeMm + 9,
                    7.5,
                    center,
                );
            }
            line(page, 14, 17, 196, 17);
            text(page, 'In 100% / Actual size. Không chọn Fit to page.', 14, 10, 8, grey);
            const footer = `Phiên bản ${input.versionNo} | Tờ ${sheetIndex + 1}/${sheets.length}`;
            text(page, footer, 196 - font.widthOfTextAtSize(footer, 8) / mm(1), 10, 8, grey);
            await input.progress?.(10 + Math.round((75 * (sheetIndex + 1)) / sheets.length));
        }
    }

    signal.throwIfAborted();
    const bytes = Buffer.from(await doc.save());
    if (bytes.length > MAX_OUTPUT_BYTES)
        throw new JobError(
            'PRINT_OUTPUT_SIZE',
            'PDF vượt giới hạn 9 MB của bài; giảm dung lượng ảnh nguồn rồi xuất bản lại.',
        );
    return bytes;
}
function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const char of value.normalize('NFC').replaceAll(/\s+/g, ' ')) {
        if (font.widthOfTextAtSize(line + char, size) > width && line) {
            lines.push(line.trim());
            line = '';
        }
        line += char;
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
}
