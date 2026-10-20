import { createHash } from 'node:crypto';
import { type CloudinaryAccount, createCloudinaryStorage } from '../../lib/cloudinary';
import { AppError } from '../../utils';
import { MAX_OUTPUT_BYTES } from '../../worker/publish/mind';
import type { PreviewGroup } from './preview.types';

export function createPreviewFileReader(account: CloudinaryAccount, network: typeof fetch = fetch) {
    const media = createCloudinaryStorage(account, network);
    return async (group: PreviewGroup, signal: AbortSignal): Promise<Buffer> => {
        signal.throwIfAborted();
        const response = await network(
            media.deliveryUrl({ resourceType: 'raw', publicId: group.publicId }),
            {
                redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
            },
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new AppError('INTERNAL_ERROR', 'Không tải được nhóm marker preview.');
        }
        if (Number(response.headers.get('content-length')) > MAX_OUTPUT_BYTES) {
            await response.body?.cancel();
            throw new AppError('INTERNAL_ERROR', 'Nhóm marker vượt giới hạn.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new AppError('INTERNAL_ERROR');
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            while (true) {
                signal.throwIfAborted();
                const part = await reader.read();
                if (part.done) break;
                length += part.value.byteLength;
                if (length > MAX_OUTPUT_BYTES) throw new AppError('INTERNAL_ERROR');
                chunks.push(part.value);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        const bytes = Buffer.concat(chunks);
        if (
            bytes.length !== group.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== group.sha256
        )
            throw new AppError('INTERNAL_ERROR', 'Nội dung marker preview không khớp.');
        signal.throwIfAborted();
        return bytes;
    };
}
export type PreviewFileReader = ReturnType<typeof createPreviewFileReader>;
