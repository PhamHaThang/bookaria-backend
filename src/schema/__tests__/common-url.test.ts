import { describe, expect, it } from 'vitest';
import { ShareInfoSchema } from '../api/publish.schema';
import { HttpUrlSchema } from '../common.schema';
import { JobResultsSchema } from '../dto.schema';

describe('HTTP URLs for local device testing', () => {
    it('accepts LAN IPs, IPv6, localhost and normal public domains', () => {
        for (const url of [
            'https://192.168.1.100:5174/b/book',
            'http://10.0.0.2:4000',
            'https://[::1]:5174/',
            'http://localhost:5173',
            'https://viewer.example.com/b/book',
        ]) {
            expect(HttpUrlSchema.safeParse(url).success).toBe(true);
        }
    });
    it('still rejects non-HTTP protocols, relative paths and invalid URLs', () => {
        for (const url of [
            'javascript:alert(1)',
            'data:text/html,hello',
            'ftp://example.com',
            'file:///tmp/file',
            '/b/book',
            'not a URL',
            'https://256.300.1.1',
        ]) {
            expect(HttpUrlSchema.safeParse(url).success).toBe(false);
        }
    });
    it('keeps LAN share and publish-job results valid through the shared contract', () => {
        const url = 'https://192.168.1.100:5174/b/test-book';
        expect(
            ShareInfoSchema.safeParse({
                url,
                qrPngUrl: 'https://cdn.example.com/qr.png',
                qrSvgUrl: 'https://cdn.example.com/qr.svg',
                embedHtml: `<iframe src="${url}"></iframe>`,
            }).success,
        ).toBe(true);
        expect(
            JobResultsSchema.PUBLISH_BOOK.safeParse({ versionNo: 1, slug: 'test-book', url })
                .success,
        ).toBe(true);
    });
});
