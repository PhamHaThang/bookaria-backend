import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import QRCode from 'qrcode';
import { z } from 'zod';
import { IdSchema, JobResultsSchema, JobSchema, JobStartedSchema, ManifestSchema } from '../schema';

async function main() {
    const bookId = IdSchema.parse(process.argv[2]),
        output = process.argv[3],
        pageId = process.argv[4];
    const token = process.env.BOOKARIA_TOKEN,
        api = process.env.BOOKARIA_API ?? 'http://localhost:4000/api/v1';
    if (!output || !token)
        throw new Error(
            'Đặt BOOKARIA_TOKEN; chạy: pnpm exec tsx src/scripts/try-preview.ts <bookId> <thư-mục-mới> [pageId]',
        );
    if (pageId) IdSchema.parse(pageId);
    const directory = resolve(output);
    // Refuse to overwrite an existing report/QR. Use a folder outside your Git repository.
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
        await call(
            `/books/${bookId}/previews`,
            'POST',
            pageId ? { scope: 'PAGE', pageId } : { scope: 'BOOK' },
        ),
    );
    console.log('jobId:', jobId);
    const deadline = Date.now() + 15 * 60_000;
    let result: z.infer<typeof JobResultsSchema.BUILD_PREVIEW>;
    while (true) {
        const job = JobSchema.parse(await call(`/jobs/${jobId}`));
        console.log(job.status, `${job.progress}%`);
        if (job.status === 'FAILED') throw new Error(JSON.stringify(job.error));
        if (job.status === 'SUCCEEDED') {
            result = JobResultsSchema.BUILD_PREVIEW.parse(job.result);
            break;
        }
        if (Date.now() > deadline)
            throw new Error('Hết thời gian chờ; kiểm tra jobId trước khi tạo yêu cầu mới.');
        await sleep(2000);
    }
    // Public preview requests carry no author access token.
    const response = await fetch(`${api}/public/previews/${result.token}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Preview HTTP ${response.status}`);
    const manifest = z.object({ data: ManifestSchema }).parse(await response.json()).data;
    const expires = response.headers.get('expires');
    if (
        !expires ||
        !Number.isFinite(Date.parse(expires)) ||
        !response.headers.get('cache-control')?.includes('no-store')
    )
        throw new Error('Thiếu Expires hoặc Cache-Control: no-store.');
    const report = {
        jobId,
        ...result,
        expiresAt: new Date(expires).toISOString(),
        pages: manifest.pages.length,
        groups: manifest.targetGroups.length,
    };
    await writeFile(resolve(directory, 'preview.json'), JSON.stringify(report, null, 2));
    await QRCode.toFile(resolve(directory, 'qr.png'), result.url, {
        width: 512,
        margin: 4,
        errorCorrectionLevel: 'M',
    });
    await writeFile(
        resolve(directory, 'qr.svg'),
        await QRCode.toString(result.url, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' }),
    );
    console.log('Đã lưu link và QR riêng tư tại:', directory);
    console.log('Hết hạn:', report.expiresAt);
    console.log(
        'Mở qr.png bằng điện thoại khi Viewer đã có route /preview/:token. Không commit thư mục này.',
    );
}
main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
