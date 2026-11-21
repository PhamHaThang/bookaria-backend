import sharp from 'sharp';
import { pool } from '../../db';
import { createR2Storage, r2Account, UPLOAD_FOLDER } from '../../lib/storage';
import { assetsRepository } from '../../modules/assets/assets.repository';
import { JobError, type JobHandler } from '../../modules/jobs/jobs.types';
import { cancelModel, generateModel } from '../../modules/model-generation/runpod';

export function createGenerateModelHandler(
    storage: Pick<ReturnType<typeof createR2Storage>, 'get' | 'put' | 'head'>,
    generate = generateModel,
): JobHandler {
    return async (ctx) => {
        const { job, signal } = ctx;
        const userId = job.created_by;
        if (!userId || job.ref_type !== 'ASSET')
            throw new JobError('INVALID_REFERENCE', 'Tác vụ tạo 3D không hợp lệ.');
        const key = `${UPLOAD_FOLDER}/${userId}/${job.ref_id}`;
        try {
            let size: number;
            const stored = await storage.head(key, signal);
            if (stored) size = Number(stored.get('content-length'));
            else {
                const intent = await assetsRepository.getUploadIntentByAssetId(
                    pool,
                    userId,
                    job.ref_id,
                );
                if (
                    intent?.purpose !== 'MODEL_INPUT' ||
                    intent.public_id !== `${UPLOAD_FOLDER}/model-inputs/${userId}/${job.ref_id}`
                )
                    throw new JobError('INVALID_INPUT', 'Không tìm thấy ảnh đầu vào của tác vụ.');
                const image = await storage.get(intent.public_id, 6 * 1024 * 1024, signal);
                const metadata = await sharp(image, { limitInputPixels: 16_777_216 }).metadata();
                if (
                    image.length !== Number(intent.size_bytes) ||
                    !['png', 'jpeg'].includes(metadata.format ?? '')
                )
                    throw new JobError(
                        'INVALID_INPUT',
                        'Ảnh đầu vào đã thay đổi hoặc không hợp lệ.',
                    );
                // A durable claim prevents another worker attempt from submitting another paid job.
                const claim = await pool.query(
                    `UPDATE jobs SET payload=payload || '{"modelSubmitted":true}'::jsonb WHERE id=$1 AND attempts=$2 AND status='RUNNING' AND NOT (payload ? 'modelSubmitted') RETURNING id`,
                    [job.id, job.attempts],
                );
                if (!claim.rowCount) {
                    if (typeof job.payload.runpodId === 'string')
                        await cancelModel(job.payload.runpodId);
                    throw new JobError(
                        'MODEL_GENERATION_INTERRUPTED',
                        'Tác vụ trước đã bị gián đoạn. Không tự gửi lại để tránh tính phí hai lần.',
                    );
                }
                await ctx.setProgress(5);
                const model = await generate(
                    image,
                    signal,
                    async (remoteId) => {
                        const saved = await pool.query(
                            `UPDATE jobs SET payload=payload || jsonb_build_object('runpodId',$3::text) WHERE id=$1 AND attempts=$2 AND status='RUNNING' RETURNING id`,
                            [job.id, job.attempts, remoteId],
                        );
                        if (!saved.rowCount)
                            throw new JobError(
                                'MODEL_GENERATION_INTERRUPTED',
                                'Tác vụ không còn hoạt động.',
                            );
                    },
                    ctx.setProgress,
                );
                await storage.put(key, model, 'model/gltf-binary', 'glb', signal);
                size = model.length;
            }
            if (!Number.isSafeInteger(size) || size <= 0 || size > 50 * 1024 * 1024)
                throw new JobError('INVALID_MODEL', 'Dung lượng mô hình không hợp lệ.');
            await ctx.setProgress(95);
            ctx.onSuccess(async (db) => {
                const quota = await assetsRepository.getQuota(db, userId, { lockForUpdate: true });
                if (!quota || quota.used + size > quota.quota)
                    throw new JobError('QUOTA_EXCEEDED', 'Không đủ dung lượng lưu mô hình 3D.');
                await assetsRepository.insertAsset(db, {
                    id: job.ref_id,
                    ownerId: userId,
                    type: 'MODEL',
                    name: String(job.payload.modelInputName),
                    publicId: key,
                    resourceType: 'image',
                    thumbnailUrl: null,
                    format: 'glb',
                    sizeBytes: size,
                    status: 'PROCESSING',
                    meta: {},
                    tags: [],
                });
                await assetsRepository.insertOptimizationJob(db, job.ref_id, userId);
            });
            return { assetId: job.ref_id };
        } catch (error) {
            if (error instanceof JobError) throw error;
            throw new JobError(
                'MODEL_GENERATION_FAILED',
                'Không hoàn tất được tác vụ tạo 3D. Không tự gửi lại yêu cầu RunPod.',
            );
        }
    };
}

export const generateModelHandler: JobHandler = (ctx) =>
    createGenerateModelHandler(createR2Storage(r2Account()))(ctx);
