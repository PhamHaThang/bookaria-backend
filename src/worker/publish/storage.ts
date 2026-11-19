import { createR2Storage, type R2Account } from '../../lib/storage';
import { JobError } from '../../modules/jobs/jobs.types';
import { MAX_PDF_BYTES } from '../print/limits';
import { MAX_MIND_BYTES, MAX_OUTPUT_BYTES } from './mind';

export function createPublishStorage(account: R2Account, fetchImpl: typeof fetch = fetch) {
    const media = createR2Storage(account, fetchImpl);
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
        prepareImage: media.prepareImage,
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
            if (
                !bytes.length ||
                bytes.length > (mime === 'application/pdf' ? MAX_PDF_BYTES : MAX_OUTPUT_BYTES)
            )
                throw new JobError(
                    'PUBLISH_FILE_SIZE',
                    'File xuất bản vượt giới hạn dung lượng hoặc rỗng.',
                );
            await media.put(publicId, bytes, mime, publicId.split('.').at(-1) ?? '', signal);
            const stored = await media.head(publicId, signal);
            if (!stored || Number(stored.get('content-length')) !== bytes.length)
                throw new JobError(
                    'PUBLISH_UPLOAD_MISMATCH',
                    'Kết quả upload không khớp file xuất bản.',
                );
            return media.deliveryUrl({ resourceType: 'raw', publicId });
        },
    };
}
export type PublishStorage = ReturnType<typeof createPublishStorage>;
