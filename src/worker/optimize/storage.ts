import z from 'zod';
import { type CloudinaryAccount, createCloudinaryStorage, signParams } from '../../lib';
import type { AssetRow } from '../../modules/assets/assets.types';
import { JobError } from '../../modules/jobs/jobs.types';
import { ASSET_MAX_BYTES } from '../../schema';

const UploadResultSchema = z.object({
    public_id: z.string(),
    resource_type: z.literal('image'),
    format: z.literal('glb'),
    bytes: z.number().int().positive(),
});

export function createProcessingStorage(
    account: CloudinaryAccount,
    fetchImpl: typeof fetch = fetch,
) {
    const media = createCloudinaryStorage(account, fetchImpl);
    async function request(url: string, signal: AbortSignal, init: RequestInit = {}) {
        let res: Response;
        try {
            res = await fetchImpl(url, {
                ...init,
                redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
            });
        } catch {
            signal.throwIfAborted();
            throw new JobError('STORAGE_UNAVAILABLE', 'Không kết nối được kho tài nguyên.', true);
        }
        if (!res.ok) {
            await res.body?.cancel();
            throw new JobError(
                'STORAGE_ERROR',
                'Kho tài nguyên chưa xử lý được tệp.',
                res.status === 408 || res.status === 420 || res.status === 429 || res.status >= 500,
            );
        }
        return res;
    }

    async function bytes(url: string, signal: AbortSignal, max: number) {
        const res = await request(url, signal);
        if (Number(res.headers.get('content-length')) > max) {
            await res.body?.cancel();
            throw new JobError('FILE_TOO_LARGE', 'Tệp tải về vượt giới hạn xử lý.');
        }
        const reader = res.body?.getReader();
        if (!reader) throw new JobError('EMPTY_FILE', 'Tệp tải về không có nội dung.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > max)
                    throw new JobError('FILE_TOO_LARGE', 'Tệp tải về vượt giới hạn xử lý.');
                chunks.push(chunk.value);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        signal.throwIfAborted();
        return Buffer.concat(chunks);
    }

    return {
        async download(a: AssetRow, signal: AbortSignal) {
            return bytes(
                media.deliveryUrl({
                    resourceType: a.resource_type,
                    publicId: a.original_public_id,
                    format: a.format,
                }),
                signal,
                ASSET_MAX_BYTES.MODEL,
            );
        },
        async uploadModel(publicId: string, data: Uint8Array, signal: AbortSignal) {
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
                new Blob([Uint8Array.from(data)], { type: 'model/gltf-binary' }),
                'model.glb',
            );
            const res = await request(
                `https://api.cloudinary.com/v1_1/${account.cloudName}/image/upload`,
                signal,
                { method: 'POST', body: form },
            );
            const uploaded = UploadResultSchema.parse(await res.json());
            if (uploaded.public_id !== publicId || uploaded.bytes !== data.byteLength) {
                throw new JobError(
                    'UPLOAD_MISMATCH',
                    'Kho tài nguyên trả về thông tin không khớp.',
                );
            }
        },
        async thumbnail(a: AssetRow, signal: AbortSignal) {
            const url = media.deliveryUrl({
                resourceType: a.resource_type,
                publicId: a.original_public_id,
                transform:
                    a.type === 'MODEL'
                        ? 'e_camera:up_15;right_30;zoom_1.0/c_pad,w_320,h_320/f_jpg'
                        : 'so_0/c_limit,w_320,h_320/f_jpg',
            });
            const data = await bytes(url, signal, 2 * 1024 * 1024);
            if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
                throw new JobError('INVALID_THUMBNAIL', 'Chưa tạo được ảnh xem trước JPEG.');
            }
            return url;
        },
        async inspect(a: AssetRow, signal: AbortSignal) {
            const path = a.original_public_id.split('/').map(encodeURIComponent).join('/');
            const metadataQuery = a.resource_type === 'video' ? '?media_metadata=true' : '';
            const res = await request(
                `https://api.cloudinary.com/v1_1/${account.cloudName}/resources/${a.resource_type}/upload/${path}${metadataQuery}`,
                signal,
                {
                    headers: {
                        Authorization: `Basic ${Buffer.from(`${account.apiKey}:${account.apiSecret}`).toString('base64')}`,
                    },
                },
            );
            const parsed = z
                .object({
                    bytes: z.number().int().positive(),
                    format: z.string(),
                    duration: z.number().positive().optional(),
                    // Audio shares Cloudinary's video resource type but has no dimensions.
                    ...(a.type !== 'AUDIO' && {
                        width: z.number().int().positive().optional(),
                        height: z.number().int().positive().optional(),
                    }),
                })
                .safeParse(await res.json());
            if (!parsed.success) {
                throw new JobError(
                    'INVALID_MEDIA_METADATA',
                    'Kho tài nguyên trả về thông tin không hợp lệ.',
                );
            }
            return parsed.data;
        },
    };
}
export type ProcessingStorage = ReturnType<typeof createProcessingStorage>;
