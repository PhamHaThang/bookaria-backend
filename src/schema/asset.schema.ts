import { z } from 'zod';
import { BytesSchema, HttpUrlSchema, IdSchema } from './common.schema';
import { AssetTypeSchema } from './enums.schema';

export const AssetMetaSchema = z.looseObject({
    /** 3D models: triangle count after optimisation. */
    triangles: z.int().min(0).optional(),
    /** 3D models: names of the animation clips. */
    animations: z.array(z.string()).optional(),
    /** Images and videos. */
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
    /** Audio and video, in seconds. */
    durationSec: z.number().min(0).optional(),
});
export type AssetMeta = z.infer<typeof AssetMetaSchema>;

export const AssetRefSchema = z.object({
    type: AssetTypeSchema,
    url: HttpUrlSchema,
    thumbnailUrl: HttpUrlSchema.nullable(),
    meta: AssetMetaSchema,
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

export const ManifestAssetSchema = z.object({
    type: AssetTypeSchema,
    url: HttpUrlSchema,
    size: BytesSchema,
    meta: AssetMetaSchema.optional(),
});
export type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

export const AssetUsageSchema = z.object({
    bookId: IdSchema,
    bookTitle: z.string(),
    pageId: IdSchema,
    pageNumber: z.int().min(1),
});
export type AssetUsage = z.infer<typeof AssetUsageSchema>;
