import type { AssetType, CloudinaryResourceType, SceneObjectType } from '../../schema';

export interface PageRow {
    id: string;
    book_id: string;
    order_index: number;
    title: string | null;
    marker_mode: 'BOOKARIA_MARKER' | 'CUSTOM_MARKER' | 'NONE';
    marker_score: number | null;
    marker_report: unknown;
    marker_mind_public_id: string | null;
    /** Số in trên marker, khi trang dùng marker Bookaria. */
    marker_number: number | null;
    marker_transform: unknown;
    object_count: number;
    settings: unknown;
    revision: number;
    updated_at: Date;
    image_asset_id: string;
    page_aspect: number;
    /** Ảnh của trang, lấy từ tài nguyên (các cột dùng để dựng địa chỉ ảnh). */
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
    /** `null`: trang không có marker Bookaria (chế độ NONE). */
    marker: { id: string; transform: unknown } | null;
    /** Bản sao của trang khác giữ nguyên cảnh và cài đặt; trang mới bắt đầu từ trống. */
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

export type AssetKind = 'MODEL' | 'IMAGE' | 'AUDIO' | 'VIDEO';
export const KIND_OF_OBJECT: Partial<Record<SceneObjectType, AssetKind>> = {
    model: 'MODEL',
    image: 'IMAGE',
    video: 'VIDEO',
    audio: 'AUDIO',
};
