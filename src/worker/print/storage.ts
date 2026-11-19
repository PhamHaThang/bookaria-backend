import { pageImageTransform } from '../../lib/page-image';
import { createR2Storage, type R2Account } from '../../lib/storage';
import { JobError } from '../../modules/jobs/jobs.types';
import type { PrintFile } from '../../modules/print/print.source';
import { createPublishStorage } from '../publish/storage';

export { MAX_PDF_BYTES } from './limits';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export function createPrintStorage(account: R2Account, network: typeof fetch = fetch) {
    const media = createR2Storage(account, network),
        published = createPublishStorage(account, network);
    return {
        url: media.deliveryUrl,
        upload: published.upload,
        async download(file: PrintFile, signal: AbortSignal): Promise<Buffer> {
            signal.throwIfAborted();
            const bytes =
                file.pageAspect === undefined
                    ? await media.get(file.publicId, MAX_IMAGE_BYTES, signal)
                    : await media.image(
                          file.publicId,
                          pageImageTransform(file.pageAspect).transform,
                          signal,
                      );
            if (bytes.length > MAX_IMAGE_BYTES)
                throw new JobError('PRINT_IMAGE_SIZE', 'Ảnh in vượt 20 MiB.');
            return bytes;
        },
    };
}
export type PrintStorage = ReturnType<typeof createPrintStorage>;
