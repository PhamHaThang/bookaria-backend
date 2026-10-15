import type { AssetStatus, MarkerMode } from '../../schema';

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
