import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFont, sampleImages, sampleSource } from '../worker/print/__tests__/fixtures';
import { renderPrintPdf } from '../worker/print/render';

const destination = resolve(process.argv[2] ?? 'output/pdf');
await mkdir(destination, { recursive: true });
for (const kind of ['PRINT', 'MARKER_SHEET'] as const) {
    const bytes = await renderPrintPdf({
        source: sampleSource(),
        request: { kind, qrMode: 'COVER_ONLY', bleedMm: 3 },
        versionNo: 1,
        url: 'https://viewer.example.com/b/bookaria-layout-demo',
        fontBytes: await readFont(),
        signal: new AbortController().signal,
        download: await sampleImages(),
    });
    await writeFile(
        resolve(destination, kind === 'PRINT' ? 'wk07-sach-mau.pdf' : 'wk07-tem-marker-mau.pdf'),
        bytes,
    );
}
console.log('Đã tạo hai PDF mẫu bố cục; marker minh họa chưa được biên dịch/kiểm định AR.');
