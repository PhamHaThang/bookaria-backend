import type { Queryable } from '../../db';
import { parseAssetMeta } from '../../modules/assets/assets.meta';
import type { AssetRow } from '../../modules/assets/assets.types';
import { JobError } from '../../modules/jobs/jobs.types';
import type { ProcessedAsset } from './types';

export const optimizeRepository = {
    async getAssetById(db: Queryable, id: string): Promise<AssetRow> {
        const { rows } = await db.query<AssetRow>(
            `SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL`,
            [id],
        );
        const asset = rows[0];
        if (!asset)
            throw new JobError('ASSET_NOT_FOUND', 'Tài nguyên đã bị xóa hoặc không tồn tại.');
        return asset;
    },
    async saveReady(db: Queryable, original: AssetRow, output: ProcessedAsset): Promise<void> {
        const meta = parseAssetMeta(original.type, { ...original.meta, ...output.meta });
        const updated = await db.query(
            `UPDATE assets SET status = 'READY', error = NULL, optimized_public_id = $2, thumbnail_url = $3, format = $4, meta = $5::jsonb
            WHERE id = $1 AND deleted_at IS NULL AND status = 'PROCESSING'
            AND original_public_id = $6`,
            [
                original.id,
                output.optimizedPublicId,
                output.thumbnailUrl,
                output.format,
                JSON.stringify(meta),
                original.original_public_id,
            ],
        );
        if (updated.rowCount !== 1) {
            throw new JobError(
                'ASSET_CHANGED',
                'Tài nguyên đã bị xóa hoặc thay đổi trong lúc xử lý.',
            );
        }
    },
    async saveFailed(
        db: Queryable,
        assetId: string,
        ownerId: string,
        message: string,
    ): Promise<void> {
        await db.query(
            `UPDATE assets SET status = 'FAILED', error = $2
      WHERE id = $1 AND owner_id = $3 AND deleted_at IS NULL AND status = 'PROCESSING'`,
            [assetId, message, ownerId],
        );
    },
};
