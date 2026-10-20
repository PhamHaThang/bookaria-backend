import { describe, expect, it, vi } from 'vitest';
import { MAX_MIND_BYTES, MAX_OUTPUT_BYTES } from '../mind';
import { createPublishStorage } from '../storage';

const account = { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' };
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
            'https://res.cloudinary.com/demo/raw/upload/bookaria/u/a%20file.mind',
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
    it('signs immutable raw uploads and checks returned byte count', async () => {
        const network = fake(async (_url, init) => {
            const form = init.body as FormData;
            expect(form.get('overwrite')).toBe('false');
            expect(form.get('signature')).toMatch(/^[a-f0-9]{40}$/);
            expect(form.has('api_secret')).toBe(false);
            expect(form.get('public_id')).toBe('p/manifest.json');
            return Response.json({ public_id: 'p/manifest.json', resource_type: 'raw', bytes: 2 });
        });
        expect(
            await createPublishStorage(account, network).upload(
                'p/manifest.json',
                Buffer.from('{}'),
                'application/json',
                signal(),
            ),
        ).toContain('/raw/upload/p/manifest.json');
        await expect(
            createPublishStorage(account, network).upload(
                'p/manifest.json',
                Buffer.from('bad'),
                'application/json',
                signal(),
            ),
        ).rejects.toMatchObject({ code: 'PUBLISH_UPLOAD_MISMATCH' });
    });
    it('rejects a mismatched resource without trusting secure_url', async () => {
        const network = fake(async () =>
            Response.json({
                public_id: 'other',
                resource_type: 'raw',
                bytes: 2,
                secure_url: 'https://evil.test/file',
            }),
        );
        await expect(
            createPublishStorage(account, network).upload(
                'x',
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
