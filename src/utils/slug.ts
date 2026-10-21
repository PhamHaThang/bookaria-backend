import { randomInt } from 'node:crypto';

const RESERVED_SLUGS = new Set([
    'admin',
    'api',
    'assets',
    'auth',
    'b',
    'books',
    'jobs',
    'me',
    'pages',
    'public',
    'studio',
    'view',
    'viewer',
]);

/**
 * Chuẩn hoá tiêu đề sách thành chuỗi thân thiện với URL (slug):
 * - Bỏ dấu tiếng Việt và ký tự có dấu (đ/Đ -> d, NFD diacritics).
 * - Chuyển sang chữ thường, chỉ giữ lại [a-z0-9-].
 * - Gộp các dấu gạch ngang liên tiếp, bỏ gạch ngang ở đầu/cuối.
 * - Giới hạn tối đa 60 ký tự.
 */
export function slugifyTitle(title: string): string {
    const normalized = title
        .replace(/[đĐ]/g, 'd')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/, '');

    const base = normalized || 'sach';
    return RESERVED_SLUGS.has(base) ? `sach-${base}` : base;
}

/**
 * Sinh chuỗi 6 ký tự base36 ngẫu nhiên an toàn mật mã.
 */
export function randomBase36Suffix(length = 6): string {
    return Array.from({ length }, () => randomInt(36).toString(36)).join('');
}

/**
 * Sinh slug chuẩn cho sách theo quyết định D12:
 * `slugify(title) (<=60 ký tự) + '-' + 6 ký tự base36 ngẫu nhiên`
 */
export function generateBookSlug(title: string): string {
    const base = slugifyTitle(title);
    const suffix = randomBase36Suffix(6);
    return `${base}-${suffix}`;
}
