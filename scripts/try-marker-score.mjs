import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const [bookId, imageFile, mindFile, ...extra] = process.argv.slice(2);
const token = process.env.BOOKARIA_TOKEN;
const api = (process.env.BOOKARIA_API ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');

function usage() {
    throw new Error(
        'Đặt BOOKARIA_TOKEN rồi chạy: node scripts/try-marker-score.mjs <bookId> <ảnh.jpg|png> <file.mind>',
    );
}

async function call(path, method = 'GET', body) {
    const response = await fetch(`${api}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json.error)}`);
    return json.data;
}

async function upload(file, purpose, mimeType) {
    const sizeBytes = (await stat(file)).size;
    const signed = await call('/assets/upload-signature', 'POST', {
        purpose,
        fileName: basename(file),
        mimeType,
        sizeBytes,
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(signed.fields)) form.set(key, String(value));
    form.set(
        'file',
        new Blob([new Uint8Array(await readFile(file))], { type: mimeType }),
        basename(file),
    );
    const response = await fetch(signed.uploadUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Cloudinary: HTTP ${response.status}`);
    const uploaded = await response.json();
    if (uploaded.public_id !== signed.fields.public_id || uploaded.bytes !== sizeBytes) {
        throw new Error(`Cloudinary trả về tệp khác tệp đã ký: ${basename(file)}`);
    }
    return signed;
}

async function main() {
    if (!bookId || !imageFile || !mindFile || extra.length || !token) usage();
    if (!UUID.test(bookId)) throw new Error('bookId phải là UUID.');
    const imageMime = IMAGE_MIME[extname(imageFile).toLowerCase()];
    if (!imageMime || extname(mindFile).toLowerCase() !== '.mind') {
        throw new Error('Cần ảnh JPG/PNG và file .mind tương ứng.');
    }
    const apiUrl = new URL(api);
    if (!['http:', 'https:'].includes(apiUrl.protocol))
        throw new Error('BOOKARIA_API phải là HTTP(S).');
    // Kiểm tra cả hai tệp trước khi tạo upload intent hoặc trang.
    for (const [file, limit] of [
        [imageFile, 10 * 1024 * 1024],
        [mindFile, 5 * 1024 * 1024],
    ]) {
        const fileStat = await stat(file);
        if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > limit) {
            throw new Error(
                `Tệp rỗng, không phải tệp thường hoặc vượt giới hạn: ${basename(file)}`,
            );
        }
    }

    const image = await upload(imageFile, 'PAGE_IMAGE', imageMime);
    const completed = await call(`/assets/${image.assetId}/complete`, 'POST', {
        name: basename(imageFile),
        tags: ['wk04-test'],
    });
    if (completed.asset?.status !== 'READY') throw new Error('Ảnh trang chưa ở trạng thái READY.');

    // MARKER_MIND là file raw, không gọi /complete.
    const mind = await upload(mindFile, 'MARKER_MIND', 'application/octet-stream');
    const created = await call(`/books/${bookId}/pages`, 'POST', {
        imageAssetId: image.assetId,
        title: basename(imageFile),
    });
    const pageId = created.page.id;
    console.log('pageId:', pageId);

    const marker = await call(`/pages/${pageId}/marker`, 'PUT', {
        mode: 'CUSTOM_MARKER',
        markerMindPublicId: mind.fields.public_id,
    });
    console.log('jobId:', marker.jobId);

    const deadline = Date.now() + 15 * 60_000;
    while (true) {
        const job = await call(`/jobs/${marker.jobId}`);
        console.log(job.status, `${job.progress}%`);
        if (job.status === 'FAILED')
            throw new Error(`Chấm marker thất bại: ${JSON.stringify(job.error)}`);
        if (job.status === 'SUCCEEDED') break;
        if (Date.now() >= deadline) {
            throw new Error('Hết thời gian chờ; kiểm tra jobId và log worker trước khi chạy lại.');
        }
        await sleep(2000);
    }
    console.log(JSON.stringify(await call(`/pages/${pageId}/marker`), null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
