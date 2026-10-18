export interface ProcessedAsset {
    optimizedPublicId: string | null;
    thumbnailUrl: string | null;
    format: string;
    meta: Record<string, unknown>;
}
