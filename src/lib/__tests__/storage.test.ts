import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { account, fakeR2 } from '../../test/r2';
import { createR2Storage, derivativeKey } from '../storage';

describe('R2 storage', () => {
    it('prepares immutable direct image URLs once and reuses cached variants without storage requests', async () => {
        const fake = fakeR2();
        fake.files.set('bookaria/image', {
            bytes: await sharp({
                create: { width: 80, height: 40, channels: 3, background: 'red' },
            })
                .png()
                .toBuffer(),
            type: 'image/png',
            format: 'png',
        });
        const media = createR2Storage(account, fake.network);
        const url = await media.prepareImage('bookaria/image', 'avatar');
        expect(url).toBe(
            `https://assets.bookaria.test/${derivativeKey('bookaria/image', 'avatar')}`,
        );
        expect(new URL(url).pathname).toMatch(/^\/derived\/v1\/[a-f0-9]{64}\/avatar\.jpg$/);
        const file = fake.files.get(derivativeKey('bookaria/image', 'avatar'));
        expect(await sharp(file?.bytes).metadata()).toMatchObject({ width: 256, height: 256 });
        fake.network.mockClear();
        expect(await media.prepareImage('bookaria/image', 'avatar')).toBe(url);
        expect(fake.network).not.toHaveBeenCalled();
        expect(() => derivativeKey('bookaria/image', '../escape')).toThrow();
        expect(() => derivativeKey('../escape', 'thumbnail')).toThrow();
    });
    it('shares concurrent preparation, retries failures and respects cancellation', async () => {
        const fake = fakeR2();
        fake.files.set('bookaria/page', {
            bytes: await sharp({
                create: { width: 64, height: 32, channels: 3, background: 'red' },
            })
                .png()
                .toBuffer(),
            type: 'image/png',
            format: 'png',
        });
        const media = createR2Storage(account, fake.network);
        fake.network.mockRejectedValueOnce(new Error('temporary failure'));
        await expect(media.prepareImage('bookaria/page', 'page-320-160')).rejects.toThrow(
            'temporary failure',
        );
        fake.network.mockClear();
        const urls = await Promise.all(
            Array.from({ length: 8 }, () => media.prepareImage('bookaria/page', 'page-320-160')),
        );
        expect(new Set(urls).size).toBe(1);
        expect(fake.network.mock.calls.map(([req]) => (req as Request).method)).toEqual([
            'HEAD',
            'GET',
            'PUT',
        ]);
        fake.network.mockClear();
        await expect(
            media.prepareImage('bookaria/page', 'page-320-160', AbortSignal.abort()),
        ).rejects.toThrow();
        expect(fake.network).not.toHaveBeenCalled();
    });
    it('bounds the preparation cache and checks existing variants after eviction or restart', async () => {
        const fake = fakeR2(),
            media = createR2Storage(account, fake.network);
        for (let i = 0; i < 257; i++) {
            fake.files.set(derivativeKey(`bookaria/${i}`, 'thumbnail'), {
                bytes: new Uint8Array([1]),
                type: 'image/jpeg',
                format: 'jpg',
            });
            await media.prepareImage(`bookaria/${i}`, 'thumbnail');
        }
        fake.network.mockClear();
        await media.prepareImage('bookaria/0', 'thumbnail');
        await createR2Storage(account, fake.network).prepareImage('bookaria/0', 'thumbnail');
        expect(fake.network.mock.calls.map(([req]) => (req as Request).method)).toEqual([
            'HEAD',
            'HEAD',
        ]);
    });

    it('lists bounded, encoded S3 keys across pages and rejects unsafe results', async () => {
        const fake = fakeR2();
        for (let index = 0; index < 105; index++)
            fake.files.set(`derived/v1/example/${String(index).padStart(3, '0')} &.jpg`, {
                bytes: new Uint8Array(1),
                type: 'image/jpeg',
                format: 'jpg',
            });
        fake.files.set('bookaria/protected', {
            bytes: new Uint8Array(1),
            type: 'image/jpeg',
            format: 'jpg',
        });
        const media = createR2Storage(account, fake.network),
            signal = new AbortController().signal;
        const first = await media.listKeys('derived/v1/example/', undefined, signal);
        expect(first.keys).toHaveLength(100);
        expect(first.keys[0]).toBe('derived/v1/example/000 &.jpg');
        expect(first.next).toBe('100');
        const second = await media.listKeys('derived/v1/example/', first.next, signal);
        expect(second.keys).toHaveLength(5);
        expect(second.next).toBeUndefined();
        for (const xml of [
            '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>bookaria/protected</Key></Contents></ListBucketResult>',
            '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
            '<!DOCTYPE data [<!ENTITY unsafe "test">]><ListBucketResult/>',
            'invalid XML',
        ])
            await expect(
                createR2Storage(account, async () => new Response(xml)).listKeys(
                    'derived/v1/example/',
                    undefined,
                    signal,
                ),
            ).rejects.toThrow();
    });

    it('signs a 15-minute PUT bound to key, length, type and a create-only condition', async () => {
        const media = createR2Storage(account);
        const signed = await media.signUpload({
            resourceType: 'image',
            publicId: 'bookaria/user/a',
            allowedFormats: ['png'],
            contentType: 'image/png',
            sizeBytes: 123,
            now: new Date('2026-11-18T00:00:00Z'),
        });
        const url = new URL(signed.uploadUrl);
        expect(url.origin).toBe(account.endpoint);
        expect(url.pathname).toBe('/bookaria-test/bookaria/user/a');
        expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
        expect(url.searchParams.get('X-Amz-Date')).toBe('20261118T000000Z');
        expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('if-none-match');
        expect(signed.headers['If-None-Match']).toBe('*');
        expect(signed.headers['Content-Type']).toBe('image/png');
        expect(signed.expiresAt.toISOString()).toBe('2026-11-18T00:15:00.000Z');
        expect(JSON.stringify(signed)).not.toContain(account.secretAccessKey);
    });
    it('stores immutable bytes, reads actual image metadata and deletes', async () => {
        const fake = fakeR2(),
            media = createR2Storage(account, fake.network);
        const image = await sharp({
            create: { width: 80, height: 40, channels: 3, background: 'red' },
        })
            .png()
            .toBuffer();
        await media.put('bookaria/a', image, 'image/png', 'jpg');
        expect(await media.get('bookaria/a', image.length)).toEqual(image);
        expect(await media.inspect('image', 'bookaria/a')).toMatchObject({
            publicId: 'bookaria/a',
            bytes: image.length,
            format: 'png',
            width: 80,
            height: 40,
        });
        await expect(media.put('bookaria/a', image, 'image/png', 'png')).rejects.toThrow('ghi đè');
        await media.destroy('image', 'bookaria/a');
        expect(await media.inspect('image', 'bookaria/a')).toBeNull();
        const signedRequest = fake.network.mock.calls[0]?.[0] as Request;
        expect(signedRequest.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    });
    it('bounds both declared and streamed bytes and respects cancellation', async () => {
        for (const response of [
            new Response('abc', { headers: { 'content-length': '10' } }),
            new Response('abc'),
        ]) {
            const network = vi.fn(async () => response);
            await expect(createR2Storage(account, network).get('bookaria/a', 2)).rejects.toThrow(
                'giới hạn',
            );
        }
        const network = vi.fn<typeof fetch>(async () => {
            throw new Error('offline');
        });
        await expect(createR2Storage(account, network).get('bookaria/a', 10)).rejects.toThrow(
            'offline',
        );
        await expect(
            createR2Storage(account, network).put(
                'bookaria/a',
                new Uint8Array(1),
                'image/png',
                'png',
                AbortSignal.abort(),
            ),
        ).rejects.toThrow();
    });
    it('rejects unsafe object keys and emits stable direct URLs for originals and variants', async () => {
        const media = createR2Storage(account);
        for (const publicId of ['../escape', 'a/../escape', 'a//b', 'a\\b', '\0']) {
            expect(() => media.deliveryUrl({ resourceType: 'raw', publicId })).toThrow();
        }
        expect(media.deliveryUrl({ resourceType: 'raw', publicId: 'bookaria/v1/a file.pdf' })).toBe(
            'https://assets.bookaria.test/bookaria/v1/a%20file.pdf',
        );
        const url = new URL(
            media.deliveryUrl({
                resourceType: 'image',
                publicId: 'bookaria/a',
                transform: 'page-800-1200',
            }),
        );
        expect(url.href).toBe(
            `https://assets.bookaria.test/${derivativeKey('bookaria/a', 'page-800-1200')}`,
        );
        expect(url.search).toBe('');
        expect(derivativeKey('bookaria/a', 'thumbnail')).not.toBe(
            derivativeKey('bookaria/a', 'avatar'),
        );
    });
});
