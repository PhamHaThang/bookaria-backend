import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
    JobResultsSchema,
    JobSchema,
    JobStartedSchema,
    ManifestSchema,
    PublicBookSchema,
    PublishCheckSchema,
    ShareInfoSchema,
} from '../schema';

async function main() {
    const bookId = process.argv[2],
        acceptWarnings = process.argv.includes('--accept-warnings');
    const token = process.env.BOOKARIA_TOKEN,
        api = process.env.BOOKARIA_API ?? 'http://localhost:4000/api/v1';
    if (!bookId || !token)
        throw new Error(
            'Đặt BOOKARIA_TOKEN rồi chạy: pnpm exec tsx src/scripts/try-publish.ts <bookId> [--accept-warnings]',
        );
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
    const check = PublishCheckSchema.parse(await call(`/books/${bookId}/publish-check`));
    console.log(JSON.stringify(check, null, 2));
    if (check.errors.length) throw new Error('Sửa các lỗi trên trước khi xuất bản.');
    if (check.warnings.length && !acceptWarnings)
        throw new Error('Đọc cảnh báo; nếu chấp nhận, chạy lại với --accept-warnings.');
    const { jobId } = JobStartedSchema.parse(
        await call(`/books/${bookId}/publish`, 'POST', {
            visibility: 'UNLISTED',
            acceptWarnings,
        }),
    );
    console.log('jobId:', jobId);
    const deadline = Date.now() + 15 * 60_000;
    let slug: string | undefined;
    while (true) {
        const job = JobSchema.parse(await call(`/jobs/${jobId}`));
        console.log(job.status, `${job.progress}%`);
        if (job.status === 'FAILED') throw new Error(JSON.stringify(job.error));
        if (job.status === 'SUCCEEDED') {
            slug = JobResultsSchema.PUBLISH_BOOK.parse(job.result).slug;
            break;
        }
        if (Date.now() > deadline)
            throw new Error('Script hết thời gian chờ; kiểm tra job trước khi tạo yêu cầu khác.');
        await sleep(2000);
    }
    const share = ShareInfoSchema.parse(await call(`/books/${bookId}/share`));
    const response = await fetch(`${api}/public/books/${slug}`, {
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Public API: HTTP ${response.status}`);
    const info = z.object({ data: PublicBookSchema }).parse(await response.json()).data;
    // No author token is sent to the CDN.
    const manifestResponse = await fetch(info.manifestUrl, { signal: AbortSignal.timeout(60_000) });
    if (!manifestResponse.ok) throw new Error(`Manifest CDN: HTTP ${manifestResponse.status}`);
    const manifest = ManifestSchema.parse(await manifestResponse.json());
    console.log(
        JSON.stringify(
            {
                share,
                manifestUrl: info.manifestUrl,
                version: manifest.version,
                pages: manifest.pages.length,
                groups: manifest.targetGroups.map((g) => ({
                    group: g.group,
                    pages: g.pageIds.length,
                    mindUrl: g.mindUrl,
                })),
            },
            null,
            2,
        ),
    );
    console.log('Backend đã xuất bản. Tiếp tục mở Viewer và quét ảnh in thật để nghiệm thu AR.');
}
main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
