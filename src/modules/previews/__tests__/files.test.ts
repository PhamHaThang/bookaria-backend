import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_OUTPUT_BYTES } from '../../../worker/publish/mind';
import { createPreviewFileReader } from '../preview.files';

const account = { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' };
const signal = () => new AbortController().signal;
const group = {
    group: 0,
    publicId: 'bookaria/previews/b/j-1/group-0.mind',
    bytes: 3,
    sha256: createHash('sha256').update('abc').digest('hex'),
};
const network = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;
describe('preview file proxy boundary', () => {
    it('reads the controlled raw URL without redirects and verifies bytes', async () => {
        const fetcher = network(new Response('abc'));
        expect((await createPreviewFileReader(account, fetcher)(group, signal())).toString()).toBe(
            'abc',
        );
        expect(fetcher).toHaveBeenCalledWith(
            `https://res.cloudinary.com/demo/raw/upload/v1/${group.publicId}`,
            expect.objectContaining({ redirect: 'error' }),
        );
    });
    it.each([
        'wrong-length',
        'wrong-hash',
        'http-error',
        'header-limit',
        'stream-limit',
        'empty',
    ] as const)('rejects %s', async (kind) => {
        const response =
            kind === 'wrong-length'
                ? new Response('ab')
                : kind === 'wrong-hash'
                  ? new Response('xyz')
                  : kind === 'http-error'
                    ? new Response('missing', { status: 404 })
                    : kind === 'header-limit'
                      ? new Response('abc', {
                            headers: { 'content-length': String(MAX_OUTPUT_BYTES + 1) },
                        })
                      : kind === 'stream-limit'
                        ? new Response(new Uint8Array(MAX_OUTPUT_BYTES + 1))
                        : new Response(null);
        await expect(
            createPreviewFileReader(account, network(response))(group, signal()),
        ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });
    it('does not fetch an aborted request', async () => {
        const abort = new AbortController();
        abort.abort();
        const fetcher = network(new Response('abc'));
        await expect(
            createPreviewFileReader(account, fetcher)(group, abort.signal),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
});
