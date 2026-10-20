import { JobError } from '../jobs/jobs.types';

export function viewerLink(origin: string, slug: string): string {
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
    return new URL(`/b/${encodeURIComponent(slug)}`, base).toString();
}
