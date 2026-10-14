import type { AssetType, CloudinaryResourceType, UploadPurpose } from '../../schema';

export interface UploadIntentRow {
    asset_id: string;
    user_id: string;
    purpose: UploadPurpose;
    public_id: string;
    resource_type: CloudinaryResourceType;
    file_name: string;
    mime_type: string;
    size_bytes: string;
    completed_at: Date | null;
}

export interface Quota {
    used: number;
    quota: number;
}

export interface AssetRow {
    id: string;
    owner_id: string | null;
    category_id: string | null;
    type: AssetType;
    name: string;
    original_public_id: string;
    resource_type: 'image' | 'video' | 'raw';
    optimized_public_id: string | null;
    thumbnail_url: string | null;
    format: string;
    size_bytes: string;
    status: 'PROCESSING' | 'READY' | 'FAILED';
    error: string | null;
    meta: Record<string, unknown>;
    tags: string[];
    license: string | null;
    author_name: string | null;
    source_url: string | null;
    created_at: Date;
}

export interface UsageRow {
    book_id: string;
    book_title: string;
    page_id: string;
    page_number: number;
}

export interface CategoryRow {
    id: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
}

export interface CompleteUploadResult {
    status: 200 | 202;
    body: { data: unknown };
}
export type AssetFile = Pick<
    AssetRow,
    'resource_type' | 'original_public_id' | 'optimized_public_id' | 'format'
>;
