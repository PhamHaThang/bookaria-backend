import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';

async function main() {
    const input = process.argv[2],
        output = process.argv[3];
    if (!input || !output)
        throw new Error(
            'Chạy: pnpm exec tsx src/scripts/trim-print.ts <PDF-có-mốc-xén> <PDF-thành-phẩm-mới>',
        );
    if (resolve(input) === resolve(output))
        throw new Error('Chọn file đầu ra khác để giữ bản có mốc xén.');
    const doc = await PDFDocument.load(await readFile(input));
    for (const page of doc.getPages()) {
        const box = page.getTrimBox();
        page.setMediaBox(box.x, box.y, box.width, box.height);
        page.setCropBox(box.x, box.y, box.width, box.height);
        page.setBleedBox(box.x, box.y, box.width, box.height);
        // Keep content coordinates and scale exactly as generated. Only the visible boxes change.
    }
    await writeFile(output, await doc.save(), { flag: 'wx' });
    console.log('Đã bỏ phần ngoài TrimBox. In Actual size / 100%, không Fit.');
}
main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
