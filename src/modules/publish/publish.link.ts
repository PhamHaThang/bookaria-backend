import { JobError } from '../jobs/jobs.types';

export function publicOrigin(origin: string): URL {
    const base = new URL(origin);
    if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== '/'
    )
        throw new JobError(
            'INVALID_VIEWER_URL',
            'VIEWER_URL phải là origin http/https, không có đường dẫn hoặc thông tin đăng nhập.',
        );
    return base;
}

export function viewerLink(origin: string, slug: string, mode?: 'ar'): string {
    const url = new URL(`/b/${encodeURIComponent(slug)}`, publicOrigin(origin));
    if (mode === 'ar') url.searchParams.set('mode', 'ar');
    return url.toString();
}
