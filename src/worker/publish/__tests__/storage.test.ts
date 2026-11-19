import { describe, expect, it, vi } from 'vitest';
import { account, fakeR2 } from '../../../test/r2';
import { MAX_MIND_BYTES, MAX_OUTPUT_BYTES } from '../mind';
import { createPublishStorage } from '../storage';

const signal = () => new AbortController().signal;
const fake = (fn: (url: string, init: RequestInit) => Promise<Response>) =>
    vi.fn(fn) as unknown as typeof fetch;
describe('publish storage', () => {
    it('uses raw URL with extension exactly once and does not follow redirects', async () => {
        const network = fake(async () => new Response('abc'));
        expect(
            (
                await createPublishStorage(account, network).downloadMind(
                    'bookaria/u/a file.mind',
                    signal(),
                )
            ).toString(),
        ).toBe('abc');
        expect(network).toHaveBeenCalledWith(
            'https://assets.bookaria.test/bookaria/u/a%20file.mind',
            expect.objectContaining({ redirect: 'error' }),
        );
    });
    it.each([404, 429, 500])('classifies HTTP %i', async (status) => {
        const network = fake(async () => new Response('', { status }));
        await expect(
            createPublishStorage(account, network).downloadMind('x.mind', signal()),
        ).rejects.toMatchObject({ retry: status !== 404 });
    });
    it('checks declared and streamed input limits', async () => {
        for (const response of [
            new Response('x', { headers: { 'content-length': String(MAX_MIND_BYTES + 1) } }),
            new Response(new Uint8Array(MAX_MIND_BYTES + 1)),
        ]) {
            await expect(
                createPublishStorage(
                    account,
                    fake(async () => response),
                ).downloadMind('x', signal()),
            ).rejects.toMatchObject({ code: 'MIND_SIZE' });
        }
    });
    it('uploads immutable JSON and PDFs larger than the old 9 MB limit', async () => {
        const fake = fakeR2(),
            storage = createPublishStorage(account, fake.network);
        expect(
            await storage.upload(
                'p/manifest.json',
                Buffer.from('{}'),
                'application/json',
                signal(),
            ),
        ).toBe('https://assets.bookaria.test/p/manifest.json');
        expect(Array.from(fake.files.get('p/manifest.json')?.bytes ?? [])).toEqual([123, 125]);
        const pdf = Buffer.alloc(9_000_001);
        expect(await storage.upload('p/print.pdf', pdf, 'application/pdf', signal())).toBe(
            'https://assets.bookaria.test/p/print.pdf',
        );
        expect(fake.files.get('p/print.pdf')?.bytes.length).toBe(pdf.length);
        await expect(
            storage.upload('p/manifest.json', Buffer.from('bad'), 'application/json', signal()),
        ).rejects.toThrow('ghi đè');
    });
    it('verifies JSON and SVG sizes without HTTP compression removing Content-Length', async () => {
        const fake = fakeR2();
        const network = vi.fn<typeof fetch>(async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            if (request.method === 'HEAD' && request.headers.get('accept-encoding') !== 'identity')
                return new Response(null, { headers: { 'content-encoding': 'gzip' } });
            return fake.network(request);
        });
        const storage = createPublishStorage(account, network);
        for (const [key, text, mime] of [
            ['p/manifest.json', '{"title":"Sách tương tác"}', 'application/json'],
            ['p/qr.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
        ] as const) {
            const bytes = Buffer.from(text);
            expect(await storage.upload(key, bytes, mime, signal())).toBe(
                `https://assets.bookaria.test/${key}`,
            );
            expect(Buffer.from(fake.files.get(key)?.bytes ?? [])).toEqual(bytes);
        }
    });
    it('rejects a mismatch in the stored object size', async () => {
        const network = vi.fn<typeof fetch>(async (input) => {
            const request = input as Request;
            return request.method === 'PUT'
                ? new Response(null)
                : new Response(null, { headers: { 'content-length': '123' } });
        });
        await expect(
            createPublishStorage(account, network).upload(
                'p/a',
                Buffer.from('{}'),
                'application/json',
                signal(),
            ),
        ).rejects.toMatchObject({ code: 'PUBLISH_UPLOAD_MISMATCH' });
    });
    it('rejects oversized output and cancellation before network access', async () => {
        const network = fake(async () => new Response('x')),
            storage = createPublishStorage(account, network);
        await expect(
            storage.upload('x', Buffer.alloc(MAX_OUTPUT_BYTES + 1), 'x', signal()),
        ).rejects.toMatchObject({ code: 'PUBLISH_FILE_SIZE' });
        const aborted = new AbortController();
        aborted.abort();
        await expect(storage.downloadMind('x', aborted.signal)).rejects.toThrow();
        expect(network).not.toHaveBeenCalled();
    });
});
