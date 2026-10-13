import type { BookStatus, BookVisibility, UserRole, UserStatus } from '../../schema';

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
