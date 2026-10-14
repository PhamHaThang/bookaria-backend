import type { AssetType, CloudinaryResourceType } from '../../schema';

export interface PageRow {
    id: string;
    book_id: string;
    order_index: number;
    title: string | null;
    marker_mode: 'BOOKARIA_MARKER' | 'CUSTOM_MARKER' | 'NONE';
    marker_score: number | null;
    marker_report: unknown;
    /** The number printed on the marker, when the page uses a Bookaria marker. */
    marker_number: number | null;
    marker_transform: unknown;
    object_count: number;
    settings: unknown;
    revision: number;
    updated_at: Date;
    image_asset_id: string;
    /** The page picture, from its asset (the columns the addresses are built from). */
    img_resource_type: 'image' | 'video' | 'raw';
    img_original_public_id: string;
    img_optimized_public_id: string | null;
    img_format: string;
    img_thumbnail_url: string | null;
    img_meta: Record<string, unknown>;
}

export interface NewPage {
    bookId: string;
    orderIndex: number;
    title: string | null;
    imageAssetId: string;
    /** Null: the page has no Bookaria marker (mode NONE). */
    marker: { id: string; transform: unknown } | null;
    /** The copy of another page keeps its scene and settings; a new page starts empty. */
    scene?: unknown;
    settings?: unknown;
}
export interface PageAssetRow {
    id: string;
    type: AssetType;
    resource_type: CloudinaryResourceType;
    original_public_id: string;
    optimized_public_id: string | null;
    format: string;
    thumbnail_url: string | null;
    meta: Record<string, unknown>;
}
