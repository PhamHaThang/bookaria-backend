import { type CloudinaryAccount, createCloudinaryStorage } from '../../lib/cloudinary';
import { JobError } from '../../modules/jobs/jobs.types';
import type { PrintFile } from '../../modules/print/print.source';
import { createPublishStorage } from '../publish/storage';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export function createPrintStorage(account: CloudinaryAccount, network: typeof fetch = fetch) {
    const media = createCloudinaryStorage(account, network),
        published = createPublishStorage(account, network);
    return {
        url: media.deliveryUrl,
        upload: published.upload,
        async download(file: PrintFile, signal: AbortSignal): Promise<Buffer> {
            signal.throwIfAborted();
            const response = await network(
                media.deliveryUrl({
                    resourceType: 'image',
                    publicId: file.publicId,
                    format: file.format,
                }),
                {
                    redirect: 'error',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
                },
            );
            if (!response.ok) {
                await response.body?.cancel();
                throw new JobError(
                    'PRINT_STORAGE_ERROR',
                    `Không tải được ảnh in (HTTP ${response.status}).`,
                    response.status === 429 || response.status >= 500,
                );
            }
            if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
                await response.body?.cancel();
                throw new JobError('PRINT_IMAGE_SIZE', 'Ảnh in vượt 20 MiB.');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new JobError('PRINT_EMPTY_IMAGE', 'Ảnh rỗng.');
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
                while (true) {
                    signal.throwIfAborted();
                    const part = await reader.read();
                    if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > MAX_IMAGE_BYTES)
                        throw new JobError('PRINT_IMAGE_SIZE', 'Ảnh in vượt 20 MiB.');
                    chunks.push(part.value);
                }
            } finally {
                await reader.cancel().catch(() => {});
            }
            return Buffer.concat(chunks);
        },
    };
}
export type PrintStorage = ReturnType<typeof createPrintStorage>;
