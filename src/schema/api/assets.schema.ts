import { z } from 'zod';
import {
    HttpUrlSchema,
    IdSchema,
    IsoDateTimeSchema,
    MB,
    PaginationQuerySchema,
    shortText,
} from '../common.schema';
import { AssetCategorySchema, AssetSchema, AssetScopeSchema } from '../dto.schema';
import {
    type AssetType,
    AssetTypeSchema,
    type UploadPurpose,
    UploadPurposeSchema,
} from '../enums.schema';

// --- Upload rules ------------------------------------------------------
export type CloudinaryResourceType = 'image' | 'video' | 'raw';

const ASSET_MIME: Record<AssetType, readonly string[]> = {
    MODEL: ['model/gltf-binary', 'model/gltf+json'],
    IMAGE: ['image/jpeg', 'image/png', 'image/webp'],
    AUDIO: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave'],
    VIDEO: ['video/mp4'],
};
export const ASSET_MAX_BYTES: Record<AssetType, number> = {
    MODEL: 10 * MB,
    IMAGE: 10 * MB,
    AUDIO: 100 * MB,
    VIDEO: 100 * MB,
};

const hasExt = (fileName: string, ...exts: string[]) =>
    exts.some((e) => fileName.toLowerCase().endsWith(e));

export function detectAssetType(mimeType: string, fileName: string): AssetType | null {
    const mime = mimeType.toLowerCase();
    if (ASSET_MIME.MODEL.includes(mime) || hasExt(fileName, '.glb', '.gltf')) return 'MODEL';
    for (const type of ['IMAGE', 'AUDIO', 'VIDEO'] as const) {
        if (ASSET_MIME[type].includes(mime)) return type;
    }
    return null;
}

export type UploadCheck =
    | {
          ok: true;
          assetType: AssetType | null;
          maxBytes: number;
          resourceType: CloudinaryResourceType;
      }
    | { ok: false; code: 'FILE_TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE'; maxBytes?: number };

export function checkUploadRequest(req: {
    purpose: UploadPurpose;
    mimeType: string;
    fileName: string;
    sizeBytes: number;
}): UploadCheck {
    const mime = req.mimeType.toLowerCase();
    const reject = (
        code: 'FILE_TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE',
        maxBytes?: number,
    ): UploadCheck => ({
        ok: false,
        code,
        ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    const sized = (
        allowed: boolean,
        maxBytes: number,
        resourceType: CloudinaryResourceType,
        assetType: AssetType | null,
    ): UploadCheck => {
        if (!allowed) return reject('FILE_TYPE_NOT_ALLOWED');
        if (req.sizeBytes > maxBytes) return reject('FILE_TOO_LARGE', maxBytes);
        return { ok: true, assetType, maxBytes, resourceType };
    };

    switch (req.purpose) {
        case 'ASSET': {
            const type = detectAssetType(req.mimeType, req.fileName);
            if (!type) return reject('FILE_TYPE_NOT_ALLOWED');
            const resourceType = type === 'AUDIO' || type === 'VIDEO' ? 'video' : 'image';
            return sized(true, ASSET_MAX_BYTES[type], resourceType, type);
        }
        case 'PAGE_IMAGE':
            return sized(['image/jpeg', 'image/png'].includes(mime), 10 * MB, 'image', 'IMAGE');
        case 'AVATAR':
            return sized(
                ['image/jpeg', 'image/png', 'image/webp'].includes(mime),
                2 * MB,
                'image',
                'IMAGE',
            );
        case 'MARKER_MIND':
            return sized(hasExt(req.fileName, '.mind'), 5 * MB, 'raw', null);
    }
}

// --- Upload signature and completion -----------------------------------------------------------------------------

/** `POST /assets/upload-signature` */
export const UploadSignatureBodySchema = z.object({
    purpose: UploadPurposeSchema,
    fileName: z.string().min(1).max(255),
    mimeType: z.string().max(100),
    sizeBytes: z.int().positive(),
});
export type UploadSignatureBody = z.infer<typeof UploadSignatureBodySchema>;

export const UploadSignatureSchema = z.object({
    assetId: IdSchema,
    uploadUrl: HttpUrlSchema,
    fields: z.looseObject({
        api_key: z.string(),
        public_id: z.string(),
        timestamp: z.int(),
        signature: z.string(),
    }),
    expiresAt: IsoDateTimeSchema,
});
export type UploadSignature = z.infer<typeof UploadSignatureSchema>;

/** `POST /assets/:assetId/complete`. The server verifies the file with Cloudinary, not these values. */
export const CompleteAssetBodySchema = z.object({
    name: shortText(150).optional(),
    tags: z.array(shortText(30)).max(20).default([]),
});
export type CompleteAssetBody = z.infer<typeof CompleteAssetBodySchema>;

/** 202: a model, audio or video file still needs processing. */
export const CompleteAssetProcessingSchema = z.object({
    asset: AssetSchema.pick({ id: true, type: true, status: true, sizeBytes: true }),
    jobId: IdSchema,
});

/** 200: page images and avatars are READY immediately. */
export const CompleteAssetReadySchema = z.object({ asset: AssetSchema });

// --- Library -------------------------------------------------------------------------------------

/** `GET /assets?scope=mine|library&type=&categoryId=&q=&tag=&hasAnimation=` */
export const ListAssetsQuerySchema = PaginationQuerySchema.extend({
    scope: AssetScopeSchema.default('mine'),
    type: AssetTypeSchema.optional(),
    categoryId: IdSchema.optional(),
    q: z.string().trim().max(100).optional(),
    tag: z.string().trim().max(30).optional(),
    hasAnimation: z.stringbool().optional(),
});
export type ListAssetsQuery = z.infer<typeof ListAssetsQuerySchema>;

export const UpdateAssetBodySchema = z
    .object({
        name: shortText(150).optional(),
        tags: z.array(shortText(30)).max(20).optional(),
        sourceUrl: HttpUrlSchema.nullable().optional(),
        license: z.string().trim().max(50).nullable().optional(),
        authorName: z.string().trim().max(150).nullable().optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
        error: 'Cần gửi ít nhất một trường để sửa',
    });
export type UpdateAssetBody = z.infer<typeof UpdateAssetBodySchema>;
export const AssetCategoryListSchema = z.array(AssetCategorySchema);
