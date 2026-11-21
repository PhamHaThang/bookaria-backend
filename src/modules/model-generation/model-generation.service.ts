import { env } from '../../config';
import { pool, withTransaction } from '../../db';
import { getMediaStorage, UPLOAD_FOLDER } from '../../lib';
import { ASSET_MAX_BYTES, ModelGenerationSchema } from '../../schema';
import { AppError } from '../../utils';
import { assetsRepository } from '../assets/assets.repository';
import { toJob } from '../jobs/jobs.service';
import type { JobRow } from '../jobs/jobs.types';

const toGeneration = (row: JobRow) =>
    ModelGenerationSchema.parse({
        ...toJob(row),
        name: ModelGenerationSchema.shape.name
            .catch('Mô hình từ ảnh')
            .parse(row.payload.modelInputName),
    });

export async function listModelGenerations(userId: string) {
    const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE type='GENERATE_MODEL' AND created_by=$1
         ORDER BY created_at DESC LIMIT 50`,
        [userId],
    );
    return rows.map(toGeneration);
}

export async function createModelGeneration(userId: string, inputId: string) {
    if (!env.RUNPOD_MODEL_API_KEY || !env.RUNPOD_MODEL_ENDPOINT_ID)
        throw new AppError('AI_UNAVAILABLE', 'Chưa cấu hình dịch vụ tạo mô hình 3D.');
    const storage = getMediaStorage();
    if (!storage) throw new AppError('AI_UNAVAILABLE', 'Chưa cấu hình kho tài nguyên.');
    const intent = await assetsRepository.getUploadIntentByAssetId(pool, userId, inputId);
    if (
        intent?.purpose !== 'MODEL_INPUT' ||
        intent.public_id !== `${UPLOAD_FOLDER}/model-inputs/${userId}/${inputId}`
    )
        throw new AppError('NOT_FOUND');
    // Returning the existing task makes uncertain HTTP retries safe.
    const existing = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE type='GENERATE_MODEL' AND created_by=$1 AND ref_id=$2 ORDER BY created_at LIMIT 1`,
        [userId, inputId],
    );
    if (existing.rows[0]) return toGeneration(existing.rows[0]);
    const file = await storage.inspect('image', intent.public_id);
    if (!file) throw new AppError('NOT_FOUND', 'Chưa tìm thấy ảnh đã tải lên.');
    if (
        !['jpg', 'png'].includes(file.format) ||
        file.bytes !== Number(intent.size_bytes) ||
        file.bytes > 6 * 1024 * 1024 ||
        !file.width ||
        !file.height ||
        file.width * file.height > 16_777_216
    ) {
        throw new AppError(
            'FILE_TYPE_NOT_ALLOWED',
            'Chọn ảnh JPG/PNG tối đa 6 MB và 16 megapixel.',
        );
    }
    return withTransaction(async (db) => {
        const quota = await assetsRepository.getQuota(db, userId, { lockForUpdate: true });
        if (!quota) throw new AppError('UNAUTHENTICATED');
        const previous = await db.query<JobRow>(
            `SELECT * FROM jobs WHERE type='GENERATE_MODEL' AND created_by=$1 AND ref_id=$2 ORDER BY created_at LIMIT 1`,
            [userId, inputId],
        );
        if (previous.rows[0]) return toGeneration(previous.rows[0]);
        const locked = await db.query(
            `SELECT asset_id FROM upload_intents WHERE asset_id=$1 AND user_id=$2 AND purpose='MODEL_INPUT' AND completed_at IS NULL AND expires_at > NOW() FOR UPDATE`,
            [inputId, userId],
        );
        if (!locked.rowCount)
            throw new AppError('NOT_FOUND', 'Ảnh tải lên đã hết hạn. Hãy tải lại ảnh.');
        if (quota.used + ASSET_MAX_BYTES.MODEL > quota.quota)
            throw new AppError(
                'QUOTA_EXCEEDED',
                'Cần ít nhất 50 MB dung lượng trống để tạo mô hình 3D.',
            );
        const active = await db.query(
            `SELECT id FROM jobs WHERE type='GENERATE_MODEL' AND created_by=$1 AND status IN ('QUEUED','RUNNING') LIMIT 1`,
            [userId],
        );
        if (active.rowCount)
            throw new AppError(
                'JOB_IN_PROGRESS',
                'Bạn đang tạo một mô hình. Hãy chờ hoàn tất trước khi tạo tiếp.',
            );
        const recent = await db.query<{ count: string }>(
            `SELECT COUNT(*) FROM jobs WHERE type='GENERATE_MODEL' AND created_by=$1 AND created_at > NOW() - INTERVAL '1 hour'`,
            [userId],
        );
        if (Number(recent.rows[0]?.count) >= 6)
            throw new AppError('RATE_LIMITED', 'Bạn đã đạt giới hạn 6 lượt tạo 3D mỗi giờ.');
        const name =
            intent.file_name
                .replace(/\.[^.]+$/, '')
                .trim()
                .slice(0, 150) || 'Mô hình từ ảnh';
        const { rows } = await db.query<JobRow>(
            `INSERT INTO jobs (type, ref_type, ref_id, created_by, payload) VALUES ('GENERATE_MODEL','ASSET',$1,$2,$3) RETURNING *`,
            [inputId, userId, JSON.stringify({ modelInputName: name })],
        );
        await assetsRepository.markUploadIntentCompleted(db, inputId);
        return toGeneration(rows[0] as JobRow);
    });
}
