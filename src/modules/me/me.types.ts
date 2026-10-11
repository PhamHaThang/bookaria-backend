/** The columns of `users` that the profile shows. */
export interface MeRow {
    id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    organization: string | null;
    bio: string | null;
    role: 'AUTHOR' | 'ADMIN';
    email_verified_at: Date | null;
    storage_used_bytes: string;
    storage_quota_bytes: string;
    created_at: Date;
}
export interface NotificationRow {
    id: string;
    type: string;
    title: string;
    body: string | null;
    link: string | null;
    read_at: Date | null;
    created_at: Date;
}
