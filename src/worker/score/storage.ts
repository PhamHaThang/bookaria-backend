import { z } from 'zod';
import { type CloudinaryAccount, createCloudinaryStorage, signParams } from '../../lib/cloudinary';
import { pageImageTransform } from '../../lib/page-image';
import { JobError } from '../../modules/jobs/jobs.types';
import type { MarkerSource } from './types';

const MAX_BYTES = 10 * 1024 * 1024;
const Uploaded = z.object({
    public_id: z.string(),
    resource_type: z.literal('image'),
    format: z.literal('png'),
    bytes: z.int().positive(),
});

export function createMarkerStorage(account: CloudinaryAccount, fetchImpl: typeof fetch = fetch) {
    const media = createCloudinaryStorage(account, fetchImpl);
    async function request(url: string, signal: AbortSignal, init: RequestInit = {}) {
        signal.throwIfAborted();
        let response: Response;
        try {
            response = await fetchImpl(url, {
                ...init,
                redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
            });
        } catch {
            signal.throwIfAborted();
            throw new JobError('STORAGE_UNAVAILABLE', 'Không kết nối được kho ảnh marker.', true);
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new JobError(
                'STORAGE_ERROR',
                'Kho ảnh marker chưa xử lý được yêu cầu.',
                [408, 420, 429].includes(response.status) || response.status >= 500,
            );
        }
        return response;
    }
    return {
        async download(page: MarkerSource, signal: AbortSignal): Promise<Buffer> {
            const response = await request(
                media.deliveryUrl({
                    resourceType: 'image',
                    publicId: page.original_public_id,
                    format: 'jpg',
                    transform: pageImageTransform(page.page_aspect).transform,
                }),
                signal,
            );
            if (Number(response.headers.get('content-length')) > MAX_BYTES) {
                await response.body?.cancel();
                throw new JobError('IMAGE_TOO_LARGE', 'Ảnh tải về vượt quá 10 MiB.');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new JobError('EMPTY_IMAGE', 'Không nhận được dữ liệu ảnh.');
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > MAX_BYTES)
                        throw new JobError('IMAGE_TOO_LARGE', 'Ảnh tải về vượt quá 10 MiB.');
                    chunks.push(chunk.value);
                }
            } finally {
                await reader.cancel().catch(() => {});
            }
            signal.throwIfAborted();
            return Buffer.concat(chunks);
        },
        async uploadHeatmap(publicId: string, png: Buffer, signal: AbortSignal): Promise<string> {
            const params = {
                public_id: publicId,
                timestamp: Math.floor(Date.now() / 1000),
                overwrite: 'false',
            };
            const form = new FormData();
            for (const [key, value] of Object.entries(params)) form.set(key, String(value));
            form.set('api_key', account.apiKey);
            form.set('signature', signParams(params, account.apiSecret));
            form.set(
                'file',
                new Blob([Uint8Array.from(png)], { type: 'image/png' }),
                'marker-heatmap.png',
            );
            const response = await request(
                `https://api.cloudinary.com/v1_1/${account.cloudName}/image/upload`,
                signal,
                { method: 'POST', body: form },
            );
            const data = Uploaded.safeParse(await response.json());
            if (
                !data.success ||
                data.data.public_id !== publicId ||
                data.data.bytes !== png.byteLength
            ) {
                throw new JobError('HEATMAP_UPLOAD_MISMATCH', 'Thông tin ảnh phủ điểm không khớp.');
            }
            return media.deliveryUrl({ resourceType: 'image', publicId, format: 'png' });
        },
    };
}
export type MarkerStorage = ReturnType<typeof createMarkerStorage>;
