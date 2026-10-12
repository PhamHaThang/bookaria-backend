import type { BookStatus, BookVisibility, PageFormat } from '../../schema';

export interface BookRow {
    id: string;
    title: string;
    cover_asset_id: string | null;
    status: BookStatus;
    visibility: BookVisibility;
    taken_down: boolean;
    page_count: number;
    updated_at: Date;
    deleted_at: Date | null;
}

export interface BookDetailRow extends BookRow {
    description: string | null;
    age_min: number | null;
    age_max: number | null;
    language: string | null;
    topic: string | null;
    page_format: PageFormat;
    page_aspect: string;
    slug: string | null;
    version_no: number | null;
    version_published_at: Date | null;
}
/** The editable columns of a book, locked for the rest of the transaction (`FOR UPDATE`). */
export interface EditableBook {
    age_min: number | null;
    age_max: number | null;
    page_format: PageFormat;
    taken_down: boolean;
}
