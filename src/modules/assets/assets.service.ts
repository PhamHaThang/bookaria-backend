import { randomUUID } from 'node:crypto';
import { logger } from '../../config';
import { pool, type Queryable, withTransaction } from '../../db';
import {
    allowedFormats,
    getMediaStorage,
    type MediaStorage,
    normalizeFormat,
    type StoredFile,
    TRANSFORM,
    UPLOAD_FOLDER,
} from '../../lib';
import { pageImageDelivery } from '../../lib/page-image';
import {
    type Asset,
    type AssetCategory,
    AssetCategoryListSchema,
    AssetRefSchema,
    AssetSchema,
    type AssetType,
    type AssetUsage,
    type CloudinaryResourceType,
    type CompleteAssetBody,
    CompleteAssetProcessingSchema,
    CompleteAssetReadySchema,
    checkUploadRequest,
    ERROR_MESSAGES,
    type ListAssetsQuery,
    type PaginationMeta,
    type UpdateAssetBody,
    type UploadSignature,
    type UploadSignatureBody,
    UploadSignatureSchema,
} from '../../schema';
import { AppError, buildPaginationMeta, toOffset } from '../../utils';
import { parseAssetMeta } from './assets.meta';
import { assetsRepository } from './assets.repository';
import type {
    AssetFile,
    AssetRow,
    CompleteUploadResult,
    UploadIntentRow,
    UsageRow,
} from './assets.types';

const MARKER_MIND_MAX_BYTES = 5 * 1024 * 1024;

export const assetsService = {
    async lockAssetForUse(
        db: Queryable,
        userId: string,
        assetId: string,
        type: AssetType,
    ): Promise<{ id: string } | undefined> {
        return await assetsRepository.lockUsableAsset(db, userId, assetId, type);
    },
    async lockAvatarForUse(
        db: Queryable,
        userId: string,
        assetId: string,
    ): Promise<string | undefined> {
        return await assetsRepository.lockOwnAvatar(db, userId, assetId);
    },
    async createUploadSignature(
        userId: string,
        body: UploadSignatureBody,
    ): Promise<UploadSignature> {
        const storage = requireStorage();

        const check = checkUploadRequest(body);
        if (!check.ok) {
            throw new AppError(
                check.code,
                ERROR_MESSAGES[check.code],
                check.maxBytes === undefined ? undefined : { maxBytes: check.maxBytes },
            );
        }

        // MARKER_MIND file không phải là asset, nên không cần check quota.
        if (body.purpose !== 'MARKER_MIND') {
            const quota = await assetsRepository.getQuota(pool, userId);
            if (!quota) throw new AppError('UNAUTHENTICATED');
            if (quota.used + body.sizeBytes > quota.quota) {
                throw new AppError('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED, {
                    used: quota.used,
                    quota: quota.quota,
                });
            }
        }

        const assetId = randomUUID();
        const extension = check.resourceType === 'raw' ? '.mind' : '';
        const publicId = `${UPLOAD_FOLDER}/${userId}/${assetId}${extension}`;
        const signed = storage.signUpload({
            publicId,
            resourceType: check.resourceType,
            allowedFormats: allowedFormats(body.purpose, check.assetType),
            assetFolder: `${UPLOAD_FOLDER}/${userId}`,
        });

        await assetsRepository.insertUploadIntent(pool, {
            assetId,
            userId,
            purpose: body.purpose,
            publicId,
            resourceType: check.resourceType,
            fileName: body.fileName,
            mimeType: body.mimeType,
            sizeBytes: body.sizeBytes,
            expiresAt: signed.expiresAt,
        });

        return UploadSignatureSchema.parse({
            assetId,
            uploadUrl: signed.uploadUrl,
            fields: signed.fields,
            expiresAt: signed.expiresAt.toISOString(),
        });
    },
    async completeUpload(
        userId: string,
        assetId: string,
        body: CompleteAssetBody,
    ): Promise<CompleteUploadResult> {
        const storage = requireStorage();

        const uploadIntent = await assetsRepository.getUploadIntentByAssetId(pool, userId, assetId);
        if (!uploadIntent) throw new AppError('NOT_FOUND');

        if (uploadIntent.purpose === 'MARKER_MIND')
            throw new AppError(
                'FILE_TYPE_NOT_ALLOWED',
                'Tệp marker không phải tài nguyên: dùng mã của nó khi lưu trang.',
            );

        const done = await assetsRepository.getAssetById(pool, assetId);
        if (done) {
            const jobId = await assetsRepository.getJobOfAsset(pool, assetId);
            return toCompleteUploadResult(storage, done, jobId);
        }

        const stored = await storage.inspect(uploadIntent.resource_type, uploadIntent.public_id);
        if (!stored)
            throw new AppError(
                'NOT_FOUND',
                'Chưa thấy file đã đã tải lại. Hãy tải lên rồi thử lại.',
            );

        const verdict = recheckUploadRequest(uploadIntent, stored);
        if (verdict instanceof AppError) {
            await discard(storage, uploadIntent);
            throw verdict;
        }
        const assetType = verdict;
        const needsProcessing = assetType !== 'IMAGE';

        try {
            return await withTransaction(async (db) => {
                const locked = await assetsRepository.getUploadIntentByAssetId(
                    db,
                    userId,
                    assetId,
                    { lockForUpdate: true },
                );
                if (!locked) throw new AppError('NOT_FOUND');
                if (locked.completed_at) {
                    const existing = await assetsRepository.getAssetById(db, assetId);
                    if (!existing) throw new AppError('NOT_FOUND');
                    const jobId = await assetsRepository.getJobOfAsset(db, assetId);
                    return toCompleteUploadResult(storage, existing, jobId);
                }

                const quota = await assetsRepository.getQuota(db, userId);
                if (!quota) throw new AppError('UNAUTHENTICATED');
                if (quota.used + stored.bytes > quota.quota) {
                    throw new AppError('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED, {
                        used: quota.used,
                        quota: quota.quota,
                    });
                }
                const isAvatar = uploadIntent.purpose === 'AVATAR';
                const asset = await assetsRepository.insertAsset(db, {
                    id: assetId,
                    ownerId: userId,
                    type: assetType,
                    name: body.name ?? nameFromFile(uploadIntent.file_name),
                    publicId: uploadIntent.public_id,
                    resourceType: uploadIntent.resource_type,
                    thumbnailUrl:
                        assetType === 'IMAGE'
                            ? storage.deliveryUrl({
                                  resourceType: 'image',
                                  publicId: uploadIntent.public_id,
                                  transform: isAvatar ? TRANSFORM.avatar : TRANSFORM.thumbnail,
                              })
                            : null,
                    format: normalizeFormat(stored.format),
                    sizeBytes: stored.bytes,
                    status: needsProcessing ? 'PROCESSING' : 'READY',
                    meta: parseAssetMeta(assetType, {
                        purpose: uploadIntent.purpose,
                        ...(stored.width !== null && { width: stored.width }),
                        ...(stored.height !== null && { height: stored.height }),
                        ...(stored.durationSec !== null && { durationSec: stored.durationSec }),
                    }),
                    tags: cleanTags(body.tags),
                });
                await assetsRepository.markUploadIntentCompleted(db, assetId);
                const jobId = needsProcessing
                    ? await assetsRepository.insertOptimizationJob(db, assetId, userId)
                    : undefined;
                return toCompleteUploadResult(storage, asset, jobId);
            });
        } catch (err) {
            if (err instanceof AppError && err.code === 'QUOTA_EXCEEDED')
                await discard(storage, uploadIntent);
            throw err;
        }
    },
    async getAssets(
        userId: string,
        q: ListAssetsQuery,
    ): Promise<{ data: Asset[]; meta: PaginationMeta }> {
        const storage = requireStorage();
        const { rows, total } = await assetsRepository.getAssets(pool, userId, {
            scope: q.scope,
            type: q.type,
            categoryId: q.categoryId,
            q: q.q,
            tag: q.tag?.toLowerCase(),
            hasAnimation: q.hasAnimation,
            limit: q.limit,
            offset: toOffset({ limit: q.limit, page: q.page }),
        });
        return {
            data: rows.map((a) => toAsset(storage, a)),
            meta: buildPaginationMeta(
                {
                    limit: q.limit,
                    page: q.page,
                },
                total,
            ),
        };
    },
    async getAsset(userId: string, assetId: string): Promise<Asset | null> {
        const storage = requireStorage();
        const asset = await assetsRepository.getVisibleAsset(pool, userId, assetId);
        if (!asset) throw new AppError('NOT_FOUND');
        return toAsset(storage, asset);
    },
    async updateAsset(userId: string, assetId: string, body: UpdateAssetBody): Promise<Asset> {
        const storage = requireStorage();
        return await withTransaction(async (db) => {
            const current = await assetsRepository.lockAssetForUpdate(db, userId, assetId);
            if (!current) throw new AppError('NOT_FOUND');

            const changes: Record<string, string | string[] | null> = {};
            if (body.name !== undefined) changes.name = body.name;
            if (body.tags !== undefined) changes.tags = cleanTags(body.tags);
            if (body.sourceUrl !== undefined) changes.source_url = body.sourceUrl;
            if (body.license !== undefined) changes.license = blankToNull(body.license);
            if (body.authorName !== undefined) changes.author_name = blankToNull(body.authorName);

            const updated = await assetsRepository.updateAsset(db, assetId, changes);
            return toAsset(storage, updated);
        });
    },
    async getAssetUsages(userId: string, assetId: string): Promise<AssetUsage[]> {
        const ownedAsset = await assetsRepository.getOwnedAsset(pool, userId, assetId);
        if (!ownedAsset) throw new AppError('NOT_FOUND');
        const rows = await assetsRepository.getAssetUsages(pool, assetId);
        return toUsages(rows);
    },
    async deleteAsset(userId: string, assetId: string): Promise<void> {
        await withTransaction(async (db) => {
            const asset = await assetsRepository.lockAssetForUpdate(db, userId, assetId);
            if (!asset) throw new AppError('NOT_FOUND');

            const usages = await assetsRepository.getAssetUsages(db, assetId);
            if (usages.length > 0) {
                throw new AppError('ASSET_IN_USE', ERROR_MESSAGES.ASSET_IN_USE, {
                    usages: toUsages(usages),
                });
            }
            if (await assetsRepository.isAssetInPublishedVersion(db, assetId)) {
                throw new AppError(
                    'ASSET_IN_USE',
                    'Tài nguyên còn được một phiên bản sách sử dụng.',
                );
            }
            // Không còn trang hoặc phiên bản nào dùng asset này.
            await assetsRepository.clearCoverImageFromBooks(db, assetId);
            await assetsRepository.clearAvatar(db, userId, asset.thumbnail_url);
            await assetsRepository.softDeleteAsset(db, assetId);
        });
    },
    // Kiểm tra xem user có quyền xem asset hay không (dùng cho các route public).
    async canSeeAsset(db: Queryable, userId: string, assetId: string): Promise<boolean> {
        return (await assetsRepository.getVisibleAsset(db, userId, assetId)) !== undefined;
    },

    // Lấy URL ảnh bìa (thumbnail) của một asset, hoặc null nếu không có.
    coverUrl(a: { resource_type: CloudinaryResourceType; public_id: string }): string | null {
        const storage = getMediaStorage();
        if (!storage) return null;
        return storage.deliveryUrl({
            resourceType: a.resource_type,
            publicId: a.public_id,
            transform: TRANSFORM.thumbnail,
        });
    },
    // Kiểm tra xem một file có phải là Marker File hay không.
    async isMarkerFileOf(userId: string, publicId: string): Promise<boolean> {
        if (!publicId.startsWith(`${UPLOAD_FOLDER}/${userId}/`) || !publicId.endsWith('.mind')) {
            return false;
        }
        const stored = await requireStorage().inspect('raw', publicId);
        return stored !== null && stored.bytes <= MARKER_MIND_MAX_BYTES;
    },
};
export const assetCategoriesService = {
    async getCategories(): Promise<AssetCategory[]> {
        const rows = await assetsRepository.getAssetCategories(pool);
        return AssetCategoryListSchema.parse(
            rows.map((r) => ({
                id: r.id,
                name: r.name,
                parentId: r.parent_id,
                sortOrder: r.sort_order,
            })),
        );
    },
};

// --- Helpers -----------------------------------------------------
function requireStorage(): MediaStorage {
    const storage = getMediaStorage();
    if (!storage) {
        logger.error(
            'Upload Route chưa được cấu hình. Vui lòng kiểm tra biến môi trường CLOUDINARY_URL',
        );
        throw new AppError('INTERNAL_ERROR');
    }
    return storage;
}
function blankToNull(value: string | null | undefined): string | null {
    return value === undefined || value === null || value === '' ? null : value;
}
function cleanTags(tags: string[]): string[] {
    return [...new Set(tags.map((t) => t.toLowerCase()))];
}
function nameFromFile(fileName: string): string {
    const base = fileName.replace(/\.[^.]*$/, '').trim();
    return (base === '' ? 'Tài nguyên' : base).slice(0, 150);
}
function fileUrl(storage: MediaStorage, a: AssetFile): string {
    return storage.deliveryUrl({
        resourceType: a.resource_type,
        publicId: a.optimized_public_id ?? a.original_public_id,
        format: a.format,
    });
}
function toAsset(storage: MediaStorage, a: AssetRow): Asset {
    return AssetSchema.parse({
        id: a.id,
        type: a.type,
        // The processed copy when the worker has made one, the original until then.
        url: fileUrl(storage, a),
        thumbnailUrl: a.thumbnail_url,
        meta: parseAssetMeta(a.type, a.meta),
        name: a.name,
        status: a.status,
        sizeBytes: Number(a.size_bytes),
        format: a.format,
        tags: a.tags,
        license: a.license,
        authorName: a.author_name,
        sourceUrl: a.source_url,
        scope: a.owner_id === null ? 'library' : 'mine',
        categoryId: a.category_id,
        error: a.error,
        createdAt: a.created_at.toISOString(),
    });
}
function toCompleteUploadResult(
    storage: MediaStorage,
    asset: AssetRow,
    jobId: string | undefined,
): CompleteUploadResult {
    if (asset.status === 'READY' || jobId === undefined) {
        return {
            status: 200,
            body: {
                data: CompleteAssetReadySchema.parse({
                    asset: toAsset(storage, asset),
                }),
            },
        };
    }
    return {
        status: 202,
        body: {
            data: CompleteAssetProcessingSchema.parse({
                asset: {
                    id: asset.id,
                    type: asset.type,
                    status: asset.status,
                    sizeBytes: Number(asset.size_bytes),
                },
                jobId,
            }),
        },
    };
}
function toUsages(rows: UsageRow[]): AssetUsage[] {
    return rows.map((r) => ({
        bookId: r.book_id,
        bookTitle: r.book_title,
        pageId: r.page_id,
        pageNumber: r.page_number,
    }));
}
// Xóa file đã upload nhưng bị từ chối
async function discard(storage: MediaStorage, uploadIntent: UploadIntentRow) {
    try {
        await storage.destroy(uploadIntent.resource_type, uploadIntent.public_id);
    } catch (err) {
        logger.warn(
            { err, publicId: uploadIntent.public_id },
            'Could not remove a rejected upload',
        );
    }
}
// Kiểm tra lại yêu cầu upload
function recheckUploadRequest(
    uploadIntent: UploadIntentRow,
    stored: StoredFile,
): AppError | AssetType {
    const check = checkUploadRequest({
        purpose: uploadIntent.purpose,
        mimeType: uploadIntent.mime_type,
        fileName: uploadIntent.file_name,
        sizeBytes: Number(uploadIntent.size_bytes),
    });
    if (!check.ok) {
        return new AppError(
            check.code,
            ERROR_MESSAGES[check.code],
            check.maxBytes === undefined ? undefined : { maxBytes: check.maxBytes },
        );
    }
    const formats = allowedFormats(uploadIntent.purpose, check.assetType);
    if (!check.assetType || !formats.includes(normalizeFormat(stored.format))) {
        return new AppError('FILE_TYPE_NOT_ALLOWED', ERROR_MESSAGES.FILE_TYPE_NOT_ALLOWED, {
            allowedFormats: formats,
        });
    }
    return check.assetType;
}

export function toAssetRef(a: AssetFile & Pick<AssetRow, 'type' | 'thumbnail_url' | 'meta'>) {
    const storage = requireStorage();
    return AssetRefSchema.parse({
        type: a.type,
        url: fileUrl(storage, a),
        thumbnailUrl: a.thumbnail_url,
        meta: parseAssetMeta(a.type, a.meta),
    });
}

export function pageImageUrls(a: AssetFile & Pick<AssetRow, 'thumbnail_url'>, aspect: number) {
    const storage = requireStorage();
    return {
        ...pageImageDelivery(storage, a.original_public_id, aspect),
        thumbnailUrl: pageImageDelivery(storage, a.original_public_id, aspect, true).url,
    };
}
