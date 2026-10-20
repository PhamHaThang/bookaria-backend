import { z } from 'zod';
import { type CloudinaryAccount, createCloudinaryStorage } from '../../lib/cloudinary';
import { JobError } from '../../modules/jobs/jobs.types';
import { MAX_MIND_BYTES, MAX_OUTPUT_BYTES } from './mind';

export function createPublishStorage(account: CloudinaryAccount, fetchImpl: typeof fetch = fetch) {
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
            throw new JobError(
                'PUBLISH_STORAGE_UNAVAILABLE',
                'Không kết nối được kho xuất bản.',
                true,
            );
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new JobError(
                'PUBLISH_STORAGE_ERROR',
                `Kho xuất bản trả HTTP ${response.status}.`,
                [408, 420, 429].includes(response.status) || response.status >= 500,
            );
        }
        return response;
    }
    return {
        url: media.deliveryUrl,
        async downloadMind(publicId: string, signal: AbortSignal): Promise<Buffer> {
            const response = await request(
                media.deliveryUrl({ resourceType: 'raw', publicId }),
                signal,
            );
            if (Number(response.headers.get('content-length')) > MAX_MIND_BYTES) {
                await response.body?.cancel();
                throw new JobError('MIND_SIZE', 'Tệp .mind vượt 5 MiB.');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new JobError('EMPTY_MIND', 'Không có dữ liệu .mind.');
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                while (true) {
                    signal.throwIfAborted();
                    const part = await reader.read();
                    if (part.done) break;
                    size += part.value.byteLength;
                    if (size > MAX_MIND_BYTES)
                        throw new JobError('MIND_SIZE', 'Tệp .mind vượt 5 MiB.');
                    chunks.push(part.value);
                }
            } finally {
                await reader.cancel().catch(() => {});
            }
            signal.throwIfAborted();
            return Buffer.concat(chunks);
        },
        async upload(
            publicId: string,
            bytes: Buffer,
            mime: string,
            signal: AbortSignal,
        ): Promise<string> {
            if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES)
                throw new JobError(
                    'PUBLISH_FILE_SIZE',
                    'File xuất bản vượt giới hạn 9 MB hoặc rỗng.',
                );
            const signed = media.signUpload({ resourceType: 'raw', publicId, allowedFormats: [] });
            const form = new FormData();
            for (const [key, value] of Object.entries(signed.fields)) form.set(key, String(value));
            form.set(
                'file',
                new Blob([Uint8Array.from(bytes)], { type: mime }),
                publicId.split('/').at(-1),
            );
            const response = await request(signed.uploadUrl, signal, {
                method: 'POST',
                body: form,
            });
            const data = z
                .object({
                    public_id: z.literal(publicId),
                    resource_type: z.literal('raw'),
                    bytes: z.literal(bytes.length),
                })
                .safeParse(await response.json());
            if (!data.success)
                throw new JobError(
                    'PUBLISH_UPLOAD_MISMATCH',
                    'Kết quả upload không khớp file xuất bản.',
                );
            return media.deliveryUrl({ resourceType: 'raw', publicId });
        },
    };
}
export type PublishStorage = ReturnType<typeof createPublishStorage>;
