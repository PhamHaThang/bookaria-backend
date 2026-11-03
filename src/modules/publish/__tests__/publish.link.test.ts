import { describe, expect, it } from 'vitest';
import { viewerLink } from '../publish.link';

describe('reader entry links', () => {
    it('keeps shared reading links stable and marks printed QR links as AR entry', () => {
        expect(viewerLink('https://reader.example', 'sach-thu')).toBe(
            'https://reader.example/b/sach-thu',
        );
        expect(viewerLink('https://reader.example', 'sach-thu', 'ar')).toBe(
            'https://reader.example/b/sach-thu?mode=ar',
        );
    });
    it('encodes book identifiers without allowing a second route or query', () => {
        const url = new URL(viewerLink('https://reader.example', 'sách/khác?mode=bad', 'ar'));
        expect(decodeURIComponent(url.pathname.slice(3))).toBe('sách/khác?mode=bad');
        expect([...url.searchParams]).toEqual([['mode', 'ar']]);
    });
    it('retains origin validation for camera entry links', () => {
        for (const origin of [
            'javascript:alert(1)',
            'https://user:pass@reader.example',
            'https://reader.example/path',
            'https://reader.example?token=1',
        ])
            expect(() => viewerLink(origin, 'sach', 'ar')).toThrow();
    });
});
