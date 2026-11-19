import { pageImageTransform } from '../../lib/page-image';
import { createR2Storage, type R2Account } from '../../lib/storage';
import { JobError } from '../../modules/jobs/jobs.types';
import { createPublishStorage } from '../publish/storage';
import type { MarkerSource } from './types';

const MAX_BYTES = 10 * 1024 * 1024;
export function createMarkerStorage(account: R2Account, fetchImpl: typeof fetch = fetch) {
    const media = createR2Storage(account, fetchImpl);
    return {
        downloadMind: createPublishStorage(account, fetchImpl).downloadMind,
        async download(page: MarkerSource, signal: AbortSignal): Promise<Buffer> {
            const bytes = await media.image(
                page.original_public_id,
                pageImageTransform(page.page_aspect).transform,
                signal,
            );
            if (bytes.length > MAX_BYTES)
                throw new JobError('IMAGE_TOO_LARGE', 'Ảnh tải về vượt quá 10 MiB.');
            return bytes;
        },
        async uploadHeatmap(publicId: string, png: Buffer, signal: AbortSignal): Promise<string> {
            await media.put(publicId, png, 'image/png', 'png', signal);
            return media.deliveryUrl({ resourceType: 'image', publicId, format: 'png' });
        },
    };
}
export type MarkerStorage = ReturnType<typeof createMarkerStorage>;
