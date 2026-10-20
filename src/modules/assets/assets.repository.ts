import { escapeLike, type Queryable } from '../../db';
import type { AssetScope, AssetType, CloudinaryResourceType, UploadPurpose } from '../../schema';
import type { AssetRow, CategoryRow, Quota, UploadIntentRow, UsageRow } from './assets.types';

const INTENT_COLUMNS = `asset_id, user_id, purpose, public_id, resource_type, file_name, mime_type, size_bytes, completed_at`;
const ASSET_COLUMNS = `id, owner_id, category_id, type, name, original_public_id, resource_type, optimized_public_id, thumbnail_url, format, size_bytes, status, error, meta, tags, license, author_name, source_url, created_at`;

export const assetsRepository = {
    // --- Upload Intents ---
    async insertUploadIntent(
        db: Queryable,
        i: {
            assetId: string;
            userId: string;
            purpose: UploadPurpose;
            publicId: string;
            resourceType: CloudinaryResourceType;
            fileName: string;
            mimeType: string;
            sizeBytes: number;
            expiresAt: Date;
        },
    ): Promise<void> {
        await db.query(
            `INSERT INTO upload_intents (asset_id, user_id, purpose, public_id, resource_type, file_name, mime_type, size_bytes, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                i.assetId,
                i.userId,
                i.purpose,
                i.publicId,
                i.resourceType,
                i.fileName,
                i.mimeType,
                i.sizeBytes.toString(),
                i.expiresAt,
            ],
        );
    },
    async getUploadIntentByAssetId(
        db: Queryable,
        userId: string,
        assetId: string,
        opts: {
            lockForUpdate?: boolean;
        } = {},
    ): Promise<UploadIntentRow | undefined> {
        const { rows } = await db.query<UploadIntentRow>(
            `SELECT ${INTENT_COLUMNS} FROM upload_intents
            WHERE asset_id = $1 AND user_id = $2
            ${opts.lockForUpdate ? 'FOR UPDATE' : ''}`,
            [assetId, userId],
        );
        return rows[0];
    },
    async markUploadIntentCompleted(db: Queryable, assetId: string): Promise<void> {
        await db.query(`UPDATE upload_intents SET completed_at = NOW() WHERE asset_id = $1`, [
            assetId,
        ]);
    },
    // --- Quota ---
    async getQuota(
        db: Queryable,
        userId: string,
        opts: { lockForUpdate?: boolean } = {},
    ): Promise<Quota | undefined> {
        const { rows } = await db.query<Quota>(
            `SELECT storage_used_bytes AS used, storage_quota_bytes AS quota FROM users WHERE id = $1
            ${opts.lockForUpdate ? 'FOR UPDATE' : ''}`,
            [userId],
        );
        return rows[0]
            ? {
                  used: Number(rows[0].used),
                  quota: Number(rows[0].quota),
              }
            : undefined;
    },
    // --- Assets ---
    async insertAsset(
        db: Queryable,
        a: {
            id: string;
            ownerId: string;
            type: AssetType;
            name: string;
            publicId: string;
            resourceType: string;
            thumbnailUrl: string | null;
            format: string;
            sizeBytes: number;
            status: 'PROCESSING' | 'READY';
            meta: Record<string, unknown>;
            tags: string[];
        },
    ): Promise<AssetRow> {
        const { rows } = await db.query<AssetRow>(
            `INSERT INTO assets
       (id, owner_id, type, name, original_public_id, resource_type, thumbnail_url, format, size_bytes, status, meta, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${ASSET_COLUMNS}`,
            [
                a.id,
                a.ownerId,
                a.type,
                a.name,
                a.publicId,
                a.resourceType,
                a.thumbnailUrl,
                a.format,
                a.sizeBytes,
                a.status,
                JSON.stringify(a.meta),
                a.tags,
            ],
        );
        return rows[0] as AssetRow;
    },
    async getAssetById(db: Queryable, assetId: string): Promise<AssetRow | undefined> {
        const { rows } = await db.query<AssetRow>(
            `SELECT ${ASSET_COLUMNS} FROM assets WHERE id = $1 AND deleted_at IS NULL`,
            [assetId],
        );
        return rows[0];
    },
    // Asset mà người dùng có thể nhìn thấy (của chính họ hoặc shared library).
    async getVisibleAsset(
        db: Queryable,
        userId: string,
        assetId: string,
    ): Promise<AssetRow | undefined> {
        const { rows } = await db.query<AssetRow>(
            `SELECT ${ASSET_COLUMNS} FROM assets
            WHERE id = $1 AND deleted_at IS NULL AND (owner_id = $2 OR (owner_id IS NULL AND status = 'READY'))`,
            [assetId, userId],
        );
        return rows[0];
    },
    async lockAssetForUpdate(
        db: Queryable,
        userId: string,
        assetId: string,
    ): Promise<AssetRow | undefined> {
        const { rows } = await db.query<AssetRow>(
            `SELECT ${ASSET_COLUMNS} FROM assets
            WHERE id = $1 AND deleted_at IS NULL AND owner_id = $2 FOR UPDATE`,
            [assetId, userId],
        );
        return rows[0];
    },
    async getOwnedAsset(
        db: Queryable,
        userId: string,
        assetId: string,
    ): Promise<AssetRow | undefined> {
        const { rows } = await db.query<AssetRow>(
            `SELECT ${ASSET_COLUMNS} FROM assets
            WHERE id = $1 AND deleted_at IS NULL AND owner_id = $2`,
            [assetId, userId],
        );
        return rows[0];
    },
    async lockUsableAsset(
        db: Queryable,
        userId: string,
        assetId: string,
        type: AssetType,
    ): Promise<{ id: string } | undefined> {
        const { rows } = await db.query<{ id: string }>(
            `SELECT id FROM assets
            WHERE id = $1 AND type = $2 AND deleted_at IS NULL AND status = 'READY'
            AND (owner_id = $3 OR owner_id IS NULL) FOR SHARE`,
            [assetId, type, userId],
        );
        return rows[0];
    },
    async lockOwnAvatar(
        db: Queryable,
        userId: string,
        assetId: string,
    ): Promise<string | undefined> {
        const { rows } = await db.query<{ thumbnail_url: string }>(
            `SELECT thumbnail_url FROM assets
            WHERE id = $1 AND deleted_at IS NULL AND status = 'READY'
            AND owner_id = $2
            AND meta->>'purpose' = 'AVATAR'
            FOR SHARE`,
            [assetId, userId],
        );
        return rows[0]?.thumbnail_url;
    },
    async getAssets(
        db: Queryable,
        userId: string,
        opts: {
            scope: AssetScope;
            type?: AssetType | undefined;
            categoryId?: string | undefined;
            q?: string | undefined;
            tag?: string | undefined;
            hasAnimation?: boolean | undefined;
            limit: number;
            offset: number;
        },
    ): Promise<{
        rows: AssetRow[];
        total: number;
    }> {
        const params: unknown[] = [];
        const add = (value: unknown) => {
            params.push(value);
            return `$${params.length}`;
        };

        const where: string[] = ['deleted_at IS NULL'];
        if (opts.scope === 'mine') {
            where.push(`owner_id = ${add(userId)}`);
            where.push(`COALESCE(meta->>'purpose', '') <> 'AVATAR'`);
        } else if (opts.scope === 'library') {
            where.push(`owner_id IS NULL`, `status = 'READY'`);
        }
        if (opts.type) where.push(`type = ${add(opts.type)}`);
        if (opts.categoryId) where.push(`category_id = ${add(opts.categoryId)}`);
        if (opts.q) where.push(`name ILIKE ${add(`%${escapeLike(opts.q)}%`)}`);
        if (opts.tag) where.push(`${add(opts.tag)} = ANY(tags)`);
        if (opts.hasAnimation !== undefined) {
            const animated = `(CASE WHEN jsonb_typeof(meta->'animations') = 'array' THEN jsonb_array_length(meta->'animations') > 0 ELSE false END)`;
            where.push(opts.hasAnimation ? animated : `NOT ${animated}`);
        }
        const clause = where.join(' AND ');

        const { rows } = await db.query<AssetRow>(
            `SELECT ${ASSET_COLUMNS} FROM assets
            WHERE ${clause}
            ORDER BY created_at DESC
            LIMIT ${add(opts.limit)} OFFSET ${add(opts.offset)}`,
            params,
        );
        const count = await db.query<{ total: number }>(
            `SELECT COUNT(*)::int AS total FROM assets WHERE ${clause}`,
            params.slice(0, params.length - 2), // Loại bỏ limit và offset
        );
        return {
            rows,
            total: count.rows[0]?.total ?? 0,
        };
    },
    async updateAsset(
        db: Queryable,
        assetId: string,
        changes: Record<string, string | string[] | null>,
    ): Promise<AssetRow> {
        const columns = Object.keys(changes);
        const assignments = columns.map((column, i) => `${column} = $${i + 2}`).join(', ');
        const { rows } = await db.query<AssetRow>(
            `UPDATE assets SET ${assignments} WHERE id = $1 RETURNING ${ASSET_COLUMNS}`,
            [assetId, ...columns.map((column) => changes[column])],
        );
        return rows[0] as AssetRow;
    },
    async softDeleteAsset(db: Queryable, assetId: string): Promise<void> {
        await db.query(`UPDATE assets SET deleted_at = NOW() WHERE id = $1`, [assetId]);
    },

    // --- Usage ---
    async getAssetUsages(db: Queryable, assetId: string): Promise<UsageRow[]> {
        const { rows } = await db.query<UsageRow>(
            `
            SELECT b.id as book_id, b.title AS book_title, p.id AS page_id, p.order_index + 1 AS page_number
            FROM pages p
            JOIN books b ON b.id = p.book_id
            WHERE p.image_asset_id = $1
            UNION
            SELECT b.id, b.title, p.id, p.order_index + 1
            FROM page_assets pa
            JOIN pages p ON p.id = pa.page_id
            JOIN books b ON b.id = p.book_id
            WHERE pa.asset_id = $1
            ORDER BY book_title, page_number, page_id`,
            [assetId],
        );
        return rows;
    },
    async isAssetInPublishedVersion(db: Queryable, assetId: string): Promise<boolean> {
        const { rows } = await db.query<{ used: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM version_assets WHERE asset_id = $1) AS used',
            [assetId],
        );
        return rows[0]?.used ?? false;
    },
    async clearCoverImageFromBooks(db: Queryable, assetId: string): Promise<void> {
        await db.query(`UPDATE books SET cover_asset_id = NULL WHERE cover_asset_id = $1`, [
            assetId,
        ]);
    },
    async clearAvatar(db: Queryable, userId: string, avatarUrl: string | null): Promise<void> {
        if (avatarUrl === null) return;
        await db.query(`UPDATE users SET avatar_url = NULL WHERE id = $1 AND avatar_url = $2`, [
            userId,
            avatarUrl,
        ]);
    },

    // --- JOB AND CATEGORY ---
    async insertOptimizationJob(db: Queryable, assetId: string, userId: string): Promise<string> {
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO jobs (type, ref_type, ref_id, created_by) VALUES ('OPTIMIZE_ASSET', 'ASSET', $1, $2) RETURNING id`,
            [assetId, userId],
        );
        return (rows[0] as { id: string }).id;
    },
    async getJobOfAsset(db: Queryable, assetId: string): Promise<string | undefined> {
        const { rows } = await db.query<{ id: string }>(
            `SELECT id FROM jobs WHERE type = 'OPTIMIZE_ASSET' AND ref_type = 'ASSET' AND ref_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [assetId],
        );
        return rows[0]?.id;
    },
    async getAssetCategories(db: Queryable): Promise<CategoryRow[]> {
        const { rows } = await db.query<CategoryRow>(
            `SELECT id, name, parent_id, sort_order FROM asset_categories ORDER BY sort_order, name, id`,
        );
        return rows;
    },
};
