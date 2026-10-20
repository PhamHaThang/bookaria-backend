import type { AssetStatus, MarkerMode } from '../../schema';
import type { AssetRow } from '../assets/assets.types';

export interface CheckAsset {
    id: string;
    status: AssetStatus;
    sizeBytes: number;
}

export interface CheckPage {
    id: string;
    orderIndex: number;
    markerMode: MarkerMode;
    markerScore: number | null;
    markerReport: unknown;
    scene: unknown;
    image: CheckAsset | null;
    assets: CheckAsset[];
}

export interface CheckInput {
    pageAspect: number;
    emailVerified: boolean;
    takenDown: boolean;
    pages: CheckPage[];
}

export interface CheckPageRow {
    id: string;
    order_index: number;
    marker_mode: MarkerMode;
    marker_score: number | null;
    marker_report: unknown;
    scene: unknown;
    image_id: string | null;
    image_status: AssetStatus | null;
    image_bytes: string | null;
}
export interface CheckAssetRow {
    id: string;
    page_id: string;
    status: AssetStatus;
    size_bytes: string;
}

export interface PublishableBook {
    id: string;
    page_aspect: string;
    taken_down: boolean;
    email_verified: boolean;
}

export type BookVersions = {
    id: string;
    version_no: number;
    page_count: number;
    ar_page_count: number;
    total_size_bytes: number;
    published_at: Date;
    published_by: string | null;
    published_by_name: string | null;
};

export interface PublishSnapshot {
    book: {
        id: string;
        owner_id: string;
        title: string;
        slug: string | null;
        page_aspect: string;
        page_width_mm: string;
        current_version_id: string | null;
        deleted_at: string | null;
        taken_down_at: string | null;
    };
    author: { status: string; email_verified_at: string | null };
    version: number;
    pages: {
        id: string;
        order_index: number;
        title: string | null;
        image_asset_id: string;
        marker_mode: MarkerMode;
        marker_score: number | null;
        marker_report: unknown;
        marker_mind_public_id: string | null;
        bookaria_marker_id: string | null;
        bookaria_marker_transform: unknown;
        scene: unknown;
        settings: unknown;
    }[];
    assets: (AssetRow & { deleted_at: string | null })[];
    markers: {
        id: string;
        number: number;
        mind_public_id: string;
        image_public_id: string;
        validated_at: string | null;
        is_active: boolean;
    }[];
}
