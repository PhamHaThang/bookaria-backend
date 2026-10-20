import { env } from '../../config';
import { pool, withTransaction } from '../../db';
import { parseCloudinaryUrl } from '../../lib/cloudinary';
import { ManifestSchema } from '../../schema';
import { AppError } from '../../utils';
import { JobError } from '../jobs/jobs.types';
import { snapshotHash } from '../publish/publish.snapshot';
import { createPreviewFileReader, type PreviewFileReader } from './preview.files';
import { previewRepository } from './preview.repository';
import { type PreviewRequest, PreviewTokenSchema, readPreviewSnapshot } from './preview.snapshot';

export async function createPreview(ownerId: string, bookId: string, body: PreviewRequest) {
    return withTransaction(async (db) => {
        try {
            const snapshot = await readPreviewSnapshot(db, ownerId, bookId, body, true);
            const open = await previewRepository.findOpenPreviewJob(db, bookId);
            if (open) throw new AppError('JOB_IN_PROGRESS', undefined, { jobId: open });
            return {
                jobId: await previewRepository.insertPreviewJob(
                    db,
                    ownerId,
                    bookId,
                    body,
                    snapshotHash(snapshot),
                ),
            };
        } catch (error) {
            if (error instanceof JobError)
                throw new AppError(
                    error.code === 'PREVIEW_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR',
                    error.message,
                );
            throw error;
        }
    });
}
async function available(token: string) {
    if (!PreviewTokenSchema.safeParse(token).success) throw new AppError('NOT_FOUND');
    const row = await previewRepository.available(pool, token);
    if (!row) throw new AppError('NOT_FOUND', 'Link không tồn tại hoặc không còn khả dụng.');
    return row;
}
export function createPreviewReader(readFile: PreviewFileReader) {
    return {
        async manifest(token: string) {
            const row = await available(token);
            return { manifest: ManifestSchema.parse(row.manifest), expiresAt: row.expires_at };
        },
        async group(token: string, group: number, signal: AbortSignal) {
            const row = await available(token),
                file = row.mind_groups.find((g) => g.group === group);
            if (!file) throw new AppError('NOT_FOUND');
            const bytes = await readFile(file, signal);
            const current = await available(token);
            if (current.id !== row.id) throw new AppError('NOT_FOUND');
            return { bytes, expiresAt: current.expires_at };
        },
    };
}
export const previewReader = createPreviewReader(async (group, signal) => {
    if (!env.CLOUDINARY_URL) throw new AppError('INTERNAL_ERROR');
    return createPreviewFileReader(parseCloudinaryUrl(env.CLOUDINARY_URL))(group, signal);
});
