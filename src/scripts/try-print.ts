import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
    IdSchema,
    JobResultsSchema,
    JobSchema,
    JobStartedSchema,
    PrintPdfBodySchema,
} from '../schema';

async function main() {
    const bookId = IdSchema.parse(process.argv[2]),
        folder = process.argv[3],
        token = process.env.BOOKARIA_TOKEN;
    const api = process.env.BOOKARIA_API ?? 'http://localhost:4000/api/v1';
    if (!folder || !token)
        throw new Error(
            'Đặt BOOKARIA_TOKEN rồi chạy: pnpm exec tsx src/scripts/try-print.ts <bookId> <folder-mới> [PRINT|MARKER_SHEET] [COVER_ONLY|ALL_AR_PAGES] [bleedMm]',
        );
    const body = PrintPdfBodySchema.parse({
        kind: process.argv[4] ?? 'PRINT',
        qrMode: process.argv[5] ?? 'COVER_ONLY',
        bleedMm: Number(process.argv[6] ?? 3),
    });
    const directory = resolve(folder);
    await mkdir(directory);
    async function call(path: string, method = 'GET', body?: unknown) {
        const response = await fetch(`${api}${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(30_000),
        });
        const json = await response.json();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json)}`);
        return z.object({ data: z.unknown() }).parse(json).data;
    }
    const { jobId } = JobStartedSchema.parse(
        await call(`/books/${bookId}/print-pdf`, 'POST', body),
    );
    console.log('jobId:', jobId);
    const deadline = Date.now() + 15 * 60_000;
    let result: z.infer<typeof JobResultsSchema.EXPORT_PDF>;
    while (true) {
        const job = JobSchema.parse(await call(`/jobs/${jobId}`));
        console.log(job.status, `${job.progress}%`);
        if (job.status === 'FAILED') throw new Error(JSON.stringify(job.error));
        if (job.status === 'SUCCEEDED') {
            result = JobResultsSchema.EXPORT_PDF.parse(job.result);
            break;
        }
        if (Date.now() > deadline)
            throw new Error('Hết thời gian chờ. Kiểm tra jobId trước khi tạo yêu cầu khác.');
        await sleep(2000);
    }
    // The CDN receives no author token. Do not follow an unexpected redirect.
    const response = await fetch(result.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('PDF rỗng');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 9_000_000) throw new Error('PDF vượt 9 MB');
            chunks.push(next.value);
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Kho không trả file PDF');
    const name = body.kind === 'PRINT' ? 'sach.pdf' : 'tem-marker.pdf';
    await writeFile(resolve(directory, name), bytes);
    await writeFile(
        resolve(directory, 'report.json'),
        JSON.stringify({ jobId, ...result, request: body, bytes: bytes.length }, null, 2),
    );
    console.log('Đã lưu PDF tại:', resolve(directory, name));
    console.log(
        'In Actual size / 100%. PDF sách có mốc xén: dùng giấy lớn hơn khổ thành phẩm hoặc crop đúng TrimBox trước khi in.',
    );
}
main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
