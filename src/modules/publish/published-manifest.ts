import { createR2Storage, r2Account } from '../../lib/storage';
import { ManifestSchema } from '../../schema';
import { AppError } from '../../utils';

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

export async function loadPublishedManifest(
    bookId: string,
    version: { version_no: number; manifest_public_id: string },
) {
    try {
        const bytes = await createR2Storage(r2Account()).get(
            version.manifest_public_id,
            MAX_MANIFEST_BYTES,
            AbortSignal.timeout(10_000),
        );
        const manifest = ManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        if (manifest.bookId !== bookId || manifest.version !== version.version_no) {
            throw new Error('Manifest không khớp với phiên bản sách.');
        }
        return manifest;
    } catch {
        throw new AppError('INTERNAL_ERROR', 'Chưa tải được bản xuất bản của sách.');
    }
}
