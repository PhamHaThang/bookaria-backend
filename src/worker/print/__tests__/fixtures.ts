import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { PrintFile, PrintSource } from '../../../modules/print/print.source';

export const readFont = () => readFile('assets/fonts/NotoSans-Regular.ttf');
export function sampleSource(widthMm = 210, heightMm = 297): PrintSource {
    return {
        schemaVersion: 1,
        cover: null,
        title: 'Khu vườn kỳ diệu - Mẫu bố cục',
        widthMm,
        heightMm,
        pages: [
            {
                pageId: randomUUID(),
                title: 'Trang thứ nhất',
                image: { publicId: 'fixture/page', format: 'png' },
                marker: {
                    mode: 'BOOKARIA_MARKER',
                    number: 17,
                    image: { publicId: 'fixture/marker', format: 'png' },
                    transform: {
                        x: 0.5 - (12 + 22.5) / widthMm,
                        y: -heightMm / (2 * widthMm) + (12 + 22.5) / widthMm,
                        size: 45 / widthMm,
                    },
                },
            },
            {
                pageId: randomUUID(),
                title: 'Trang thứ hai',
                image: { publicId: 'fixture/page', format: 'png' },
                marker: { mode: 'NONE' },
            },
        ],
    };
}
export async function sampleImages(width = 840, height = 1188) {
    const page = await sharp(
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 840 1188">
        <rect width="840" height="1188" fill="#edf3e9"/><text x="64" y="115" font-family="Arial" font-size="46" fill="#183e33">KHU VƯỜN KỲ DIỆU</text>
        <text x="66" y="163" font-family="Arial" font-size="22" fill="#45664e">Mẫu bố cục in - ảnh và marker minh họa</text>
        <path d="M415 940 V470 M415 700 L260 540 M415 610 L570 430" stroke="#315a40" stroke-width="22" fill="none"/>
        <ellipse cx="266" cy="493" rx="96" ry="146" fill="#789b62" transform="rotate(-35 266 493)"/>
        <ellipse cx="565" cy="396" rx="95" ry="148" fill="#97b97c" transform="rotate(35 565 396)"/>
        <ellipse cx="414" cy="322" rx="94" ry="142" fill="#537a53"/>
        <path d="M320 965 L510 965 L485 1090 L345 1090 Z" fill="#bd8060"/>
        <text x="65" y="1150" font-family="Arial" font-size="20" fill="#45664e">Bookaria / Trang thực hành</text></svg>`),
    )
        .png()
        .toBuffer();
    const marker = await sharp(
        Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><rect width="360" height="360" fill="white"/><path d="M18 18H342V342H18Z" fill="none" stroke="black" stroke-width="12"/><path d="M40 40H150V130H40Z M190 40H318V78H190Z M215 95H318V155H215Z M40 190L125 155L170 260L70 310Z M210 195L320 175L300 305L180 318Z" fill="black"/><circle cx="177" cy="151" r="19" fill="black"/></svg>',
        ),
    )
        .png()
        .toBuffer();
    return async (file: PrintFile) => (file.publicId.includes('marker') ? marker : page);
}
