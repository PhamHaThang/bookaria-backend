export interface CardBookRow {
    slug: string;
    title: string;
    language: string;
    age_min: number | null;
    age_max: number | null;
    owner_id: string;
    author_name: string;
    ar_page_count: number | null;
    cover_public_id: string | null;
    cover_resource_type: 'image' | 'video' | 'raw' | null;
}

export interface AuthorRow {
    id: string;
    display_name: string;
    organization: string | null;
    bio: string | null;
    avatar_url: string | null;
}

export interface PublicBookRow extends CardBookRow {
    id: string;
    description: string | null;
    visibility: 'PRIVATE' | 'UNLISTED' | 'PUBLIC';
    deleted_at: Date | null;
    taken_down_at: Date | null;
    owner_active: boolean;
    version_id: string | null;
    version_no: number | null;
    published_at: Date | null;
    manifest_public_id: string | null;
    page_count: number | null;
    total_size_bytes: string | null;
    print_pdf_public_id: string | null;
}
export interface EventBook {
    version_id: string;
    book_id: string;
}

export interface NewEvent {
    pageId: string | null;
    event: 'OPEN' | 'PAGE_FOUND' | 'TAP' | 'SCAN_TIMEOUT';
    objectId: string | null;
}
