import { vi } from 'vitest';
import type { R2Account } from '../lib/storage';

export const account: R2Account = {
    endpoint: 'https://account.r2.cloudflarestorage.com',
    accessKeyId: 'test',
    secretAccessKey: 'secret',
    bucket: 'bookaria-test',
    publicUrl: 'https://assets.bookaria.test',
};
export function fakeR2() {
    const files = new Map<string, { bytes: Uint8Array; type: string; format: string }>();
    const network = vi.fn<typeof fetch>(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.searchParams.get('list-type') === '2') {
            const prefix = url.searchParams.get('prefix') ?? '';
            const keys = [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
            const offset = Number(url.searchParams.get('continuation-token') ?? 0);
            const maximum = Number(url.searchParams.get('max-keys') ?? 100);
            const page = keys.slice(offset, offset + maximum);
            const next = offset + page.length < keys.length ? offset + page.length : undefined;
            return new Response(
                `<ListBucketResult><IsTruncated>${next !== undefined}</IsTruncated>${page.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join('')}${next === undefined ? '' : `<NextContinuationToken>${next}</NextContinuationToken>`}</ListBucketResult>`,
            );
        }
        const key = decodeURIComponent(
            url.pathname.replace(/^\/bookaria-test\//, '').replace(/^\//, ''),
        );
        const existing = files.get(key);
        if (request.method === 'PUT') {
            if (existing && request.headers.get('if-none-match') === '*')
                return new Response(null, { status: 412 });
            files.set(key, {
                bytes: new Uint8Array(await request.arrayBuffer()),
                type: request.headers.get('content-type') ?? '',
                format: request.headers.get('x-amz-meta-format') ?? '',
            });
            return new Response(null, { status: 200 });
        }
        if (request.method === 'DELETE') {
            files.delete(key);
            return new Response(null, { status: 204 });
        }
        if (!existing) return new Response(null, { status: 404 });
        const headers = {
            'Content-Length': String(existing.bytes.length),
            'Content-Type': existing.type,
            'x-amz-meta-format': existing.format,
        };
        return new Response(request.method === 'HEAD' ? null : Uint8Array.from(existing.bytes), {
            headers,
        });
    });
    return { files, network };
}
