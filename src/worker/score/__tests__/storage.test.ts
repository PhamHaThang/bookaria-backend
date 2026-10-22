import { describe, expect, it, vi } from 'vitest';
import { createMarkerStorage } from '../storage';
import type { MarkerSource } from '../types';

const account = { cloudName: 'demo', apiKey: 'test-key', apiSecret: 'test-secret' };
const page = {
    original_public_id: 'bookaria/u/page one',
    format: 'png',
    size_bytes: '3',
} as MarkerSource;
const signal = () => new AbortController().signal;
const fetcher = (fn: () => Promise<Response>) => vi.fn(fn) as unknown as typeof fetch;

describe('marker storage', () => {
    it('uses only an encoded original Cloudinary URL, with no automatic transformation', async () => {
        const network = fetcher(async () => new Response('png'));
        expect(
            (await createMarkerStorage(account, network).download(page, signal())).toString(),
        ).toBe('png');
        expect(network).toHaveBeenCalledWith(
            'https://res.cloudinary.com/demo/image/upload/v1/bookaria/u/page%20one.png',
            expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
        );
    });
    it('checks both declared and streamed size limits', async () => {
        const header = fetcher(
            async () => new Response('x', { headers: { 'content-length': '20000000' } }),
        );
        await expect(
            createMarkerStorage(account, header).download(page, signal()),
        ).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
                controller.close();
            },
        });
        const network = fetcher(async () => new Response(stream));
        const outcome = await createMarkerStorage(account, network)
            .download(page, signal())
            .then(
                () => 'unexpected',
                (error: { code: string }) => error.code,
            );
        expect(outcome).toBe('IMAGE_TOO_LARGE');
    });
    it('rejects a size mismatch with the stored original', async () => {
        const network = fetcher(async () => new Response('changed'));
        await expect(
            createMarkerStorage(account, network).download(page, signal()),
        ).rejects.toMatchObject({ code: 'SOURCE_CHANGED', retry: false });
    });
    it.each([408, 420, 429, 500])('retries HTTP %i', async (status) => {
        const network = fetcher(async () => new Response('', { status }));
        await expect(
            createMarkerStorage(account, network).download(page, signal()),
        ).rejects.toMatchObject({ retry: true });
    });
    it('does not retry a missing original', async () => {
        const network = fetcher(async () => new Response('', { status: 404 }));
        await expect(
            createMarkerStorage(account, network).download(page, signal()),
        ).rejects.toMatchObject({ retry: false });
    });
    it('retries a connection failure', async () => {
        const network = fetcher(async () => {
            throw new TypeError('offline');
        });
        await expect(
            createMarkerStorage(account, network).download(page, signal()),
        ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', retry: true });
    });
    it('uploads a signed PNG without sending the secret and generates the delivery URL locally', async () => {
        let form: FormData | undefined;
        const network: typeof fetch = async (_url, init) => {
            form = init?.body as FormData;
            return Response.json({
                public_id: 'reports/attempt-1',
                resource_type: 'image',
                format: 'png',
                bytes: 3,
                secure_url: 'https://untrusted.invalid',
            });
        };
        const url = await createMarkerStorage(account, network).uploadHeatmap(
            'reports/attempt-1',
            Buffer.from('png'),
            signal(),
        );
        expect(url).toBe('https://res.cloudinary.com/demo/image/upload/v1/reports/attempt-1.png');
        expect(form?.get('signature')).toEqual(expect.any(String));
        expect(form?.get('overwrite')).toBe('false');
        expect(form?.get('api_secret')).toBeNull();
        const file = form?.get('file');
        expect(file).toBeInstanceOf(Blob);
        expect((file as Blob).type).toBe('image/png');
    });
    it('rejects an upload response for another id', async () => {
        const network = fetcher(async () =>
            Response.json({ public_id: 'wrong', resource_type: 'image', format: 'png', bytes: 3 }),
        );
        await expect(
            createMarkerStorage(account, network).uploadHeatmap(
                'right',
                Buffer.from('png'),
                signal(),
            ),
        ).rejects.toMatchObject({ code: 'HEATMAP_UPLOAD_MISMATCH' });
    });
    it('does not issue a request after cancellation', async () => {
        const controller = new AbortController();
        controller.abort();
        const network = fetcher(async () => new Response('png'));
        await expect(
            createMarkerStorage(account, network).download(page, controller.signal),
        ).rejects.toThrow();
        expect(network).not.toHaveBeenCalled();
    });
});
