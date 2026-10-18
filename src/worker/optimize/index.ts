import { env } from '../../config';
import { pool } from '../../db';
import { parseCloudinaryUrl } from '../../lib/cloudinary';
import { JobError, type JobHandler } from '../../modules/jobs/jobs.types';
import { AssetMetaSchema, JobResultsSchema } from '../../schema';
import { optimizeModel } from './model';
import { optimizeRepository } from './repo';
import { createProcessingStorage, type ProcessingStorage } from './storage';
import type { ProcessedAsset } from './types';

export function createOptimizeHandler(
    storage: ProcessingStorage,
    modelProcessor: typeof optimizeModel = optimizeModel,
    repository: Pick<typeof optimizeRepository, 'getAssetById' | 'saveReady'> = optimizeRepository,
): JobHandler {
    return async (ctx) => {
        if (ctx.job.ref_type !== 'ASSET') {
            throw new JobError('INVALID_REFERENCE', 'Tác vụ không tham chiếu tới tài nguyên.');
        }
        ctx.signal.throwIfAborted();
        const asset = await repository.getAssetById(pool, ctx.job.ref_id);
        if (!ctx.job.created_by || asset.owner_id !== ctx.job.created_by) {
            throw new JobError('INVALID_OWNER', 'Chủ sở hữu tài nguyên không khớp tác vụ.');
        }
        if (asset.status === 'READY') {
            return JobResultsSchema.OPTIMIZE_ASSET.parse({ assetId: asset.id, meta: asset.meta });
        }
        if (asset.status !== 'PROCESSING') {
            throw new JobError(
                'ASSET_NOT_PROCESSING',
                'Tài nguyên không còn ở trạng thái đang xử lý.',
            );
        }
        await ctx.setProgress(10);
        let output: ProcessedAsset;
        if (asset.type === 'MODEL') {
            const stored = await storage.inspect(asset, ctx.signal);
            if (stored.format !== asset.format || stored.bytes !== Number(asset.size_bytes)) {
                throw new JobError('SOURCE_CHANGED', 'Tệp gốc đã thay đổi sau khi tải lên.');
            }
            const input = await storage.download(asset, ctx.signal);
            if (input.byteLength !== stored.bytes) {
                throw new JobError('SOURCE_CHANGED', 'Tệp gốc đã thay đổi trong lúc xử lý.');
            }
            await ctx.setProgress(25);
            const model = await modelProcessor(input, ctx.signal);
            await ctx.setProgress(65);
            const publicId = `bookaria/processed/${asset.id}/${ctx.job.id}-${ctx.job.attempts}`;
            await storage.uploadModel(publicId, model.bytes, ctx.signal);
            output = {
                optimizedPublicId: publicId,
                format: 'glb',
                thumbnailUrl: await storage.thumbnail(asset, ctx.signal),
                meta: model.meta,
            };
        } else if (asset.type === 'AUDIO' || asset.type === 'VIDEO') {
            const stored = await storage.inspect(asset, ctx.signal);
            if (stored.format !== asset.format || stored.bytes !== Number(asset.size_bytes)) {
                throw new JobError('SOURCE_CHANGED', 'Tệp gốc đã thay đổi sau khi tải lên.');
            }
            if (stored.duration === undefined || stored.duration <= 0) {
                throw new JobError(
                    'INVALID_MEDIA',
                    'Không đọc được thời lượng âm thanh hoặc video.',
                );
            }
            if (asset.type === 'VIDEO' && (!stored.width || !stored.height)) {
                throw new JobError('INVALID_VIDEO', 'Không đọc được kích thước video.');
            }
            output = {
                optimizedPublicId: null,
                format: asset.format,
                thumbnailUrl:
                    asset.type === 'VIDEO' ? await storage.thumbnail(asset, ctx.signal) : null,
                meta: {
                    durationSec: stored.duration,
                    downloadBytes: stored.bytes,
                    ...(asset.type === 'VIDEO' && { width: stored.width, height: stored.height }),
                },
            };
        } else {
            throw new JobError('UNSUPPORTED_ASSET', 'Ảnh được xử lý tại bước hoàn tất tải lên.');
        }
        ctx.signal.throwIfAborted();
        const meta = AssetMetaSchema.parse({ ...asset.meta, ...output.meta });
        const result = JobResultsSchema.OPTIMIZE_ASSET.parse({ assetId: asset.id, meta });
        await ctx.setProgress(95);
        ctx.onSuccess((db) => repository.saveReady(db, asset, output));
        return result;
    };
}
export const optimizeAssetHandler: JobHandler = async (ctx) => {
    if (!env.CLOUDINARY_URL) {
        throw new JobError(
            'STORAGE_NOT_CONFIGURED',
            'Chưa cấu hình kho tài nguyên cho worker.',
            true,
        );
    }
    return createOptimizeHandler(createProcessingStorage(parseCloudinaryUrl(env.CLOUDINARY_URL)))(
        ctx,
    );
};
