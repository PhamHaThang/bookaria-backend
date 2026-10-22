import { type AssetMeta, AssetMetaSchema, type AssetType } from '../../schema';

export function parseAssetMeta(type: AssetType, meta: Record<string, unknown>): AssetMeta {
    const normalized = { ...meta };
    // Cloudinary stores audio under resource_type=video and reports zero dimensions.
    // Audio has no spatial dimensions, including in rows saved before normalization.
    if (type === 'AUDIO') {
        delete normalized.width;
        delete normalized.height;
    }
    return AssetMetaSchema.parse(normalized);
}
