import type {
    AssetStatus,
    AssetType,
    AuditAction,
    BookStatus,
    BookVisibility,
    MarkerMode,
    ReportReason,
    ReportStatus,
    UserRole,
    UserStatus,
} from '../../schema';

export interface LibraryAssetRow {
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
    status: AssetStatus;
    error: string | null;
    meta: Record<string, unknown>;
    tags: string[];
    license: string | null;
    author_name: string | null;
    source_url: string | null;
    created_at: Date;
}

export interface AssetCategoryRow {
    id: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
}

export interface AssetUsageCountsRow {
    cover_count: number;
    page_image_count: number;
    page_asset_count: number;
}

export interface AdminDashboardMetricsRow {
    users: number;
    published_books: number;
    storage_used_bytes: string;
    failed_jobs_24h: number;
    open_reports: number;
}

export interface PublishedPerDayRow {
    date: string;
    count: number;
}

export interface AuditActionTodayRow {
    action: AuditAction;
    count: number;
}

export interface ModerationQueueRow {
    book_id: string;
    book_title: string;
    author_id: string;
    author_display_name: string;
    report_count: number;
    reasons: ReportReason[];
    last_reported_at: Date;
}

export interface ModerationBookRow {
    id: string;
    title: string;
    description: string | null;
    cover_url: string | null;
    status: BookStatus;
    visibility: BookVisibility;
    taken_down: boolean;
    taken_down_reason: string | null;
    page_count: number;
    report_count: number;
    updated_at: Date;
    author_id: string;
    author_display_name: string;
}

export interface ModerationPageRow {
    id: string;
    order_index: number;
    title: string | null;
    thumbnail_url: string | null;
    marker_mode: MarkerMode;
    marker_number: number | null;
    marker_score: number | null;
    object_count: number;
}

export interface ModerationReportRow {
    id: string;
    reason: ReportReason;
    note: string | null;
    status: ReportStatus;
    created_at: Date;
    handled_at: Date | null;
}

export interface LockedModerationBookRow {
    id: string;
    owner_id: string;
    title: string;
    visibility: BookVisibility;
    visibility_before_lock: BookVisibility | null;
    taken_down_at: Date | null;
    owner_status: UserStatus;
}

export interface AdminUserRow {
    id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    organization: string | null;
    bio: string | null;
    role: UserRole;
    status: UserStatus;
    email_verified_at: Date | null;
    storage_used_bytes: string;
    storage_quota_bytes: string;
    book_count: number;
    last_login_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

export interface AdminBookRow {
    id: string;
    title: string;
    status: BookStatus;
    visibility: BookVisibility;
    taken_down: boolean;
    page_count: number;
    updated_at: Date;
}

export interface LockedUserRow {
    id: string;
    display_name: string;
    role: UserRole;
    status: UserStatus;
    storage_quota_bytes: string;
}

export interface CurrentAdminRow {
    role: UserRole;
    status: UserStatus;
    session_active: boolean;
}
