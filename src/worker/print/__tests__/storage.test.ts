import { describe, expect, it, vi } from 'vitest';
import { createPrintStorage, MAX_IMAGE_BYTES } from '../storage';

const account = { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' },
    file = { publicId: 'bookaria/u/page', format: 'png' };
const fake = (r: Response) => vi.fn(async () => r) as unknown as typeof fetch;
describe('PDF image storage', () => {
    it('downloads from controlled Cloudinary image paths without redirects', async () => {
        const network = fake(new Response('abc'));
        expect(
            (
                await createPrintStorage(account, network).download(
                    file,
                    new AbortController().signal,
                )
            ).toString(),
        ).toBe('abc');
        expect(network).toHaveBeenCalledWith(
            'https://res.cloudinary.com/demo/image/upload/bookaria/u/page.png',
            expect.objectContaining({ redirect: 'error' }),
        );
    });
    it.each([404, 429, 500])('classifies HTTP %i', async (status) => {
        await expect(
            createPrintStorage(account, fake(new Response('', { status }))).download(
                file,
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ code: 'PRINT_STORAGE_ERROR', retry: status !== 404 });
    });
    it('enforces declared and actual download length limits', async () => {
        for (const response of [
            new Response('x', { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } }),
            new Response(new Uint8Array(MAX_IMAGE_BYTES + 1)),
        ])
            await expect(
                createPrintStorage(account, fake(response)).download(
                    file,
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: 'PRINT_IMAGE_SIZE' });
    });
});
