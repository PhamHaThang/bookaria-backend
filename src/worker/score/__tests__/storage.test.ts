import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { account, fakeR2 } from '../../../test/r2';
import { createMarkerStorage } from '../storage';
import type { MarkerSource } from '../types';

describe('R2 marker storage', () => {
    it('uses a cached JPEG with exactly the same geometry as the compiler and print worker', async () => {
        const fake = fakeR2();
        const bytes = await sharp({
            create: { width: 200, height: 200, channels: 3, background: 'red' },
        })
            .png()
            .toBuffer();
        fake.files.set('bookaria/page', { bytes, type: 'image/png', format: 'png' });
        const page = { original_public_id: 'bookaria/page', page_aspect: 0.5 } as MarkerSource;
        const storage = createMarkerStorage(account, fake.network),
            signal = new AbortController().signal;
        const derived = await storage.download(page, signal);
        expect(await sharp(derived).metadata()).toMatchObject({
            format: 'jpeg',
            width: 1600,
            height: 800,
        });
        const before = fake.network.mock.calls.length;
        expect(await storage.download(page, signal)).toEqual(derived);
        expect(
            fake.network.mock.calls
                .slice(before)
                .some((call) => (call[0] as Request).method === 'PUT'),
        ).toBe(false);
    });
    it('stores PNG heatmaps immutably and derives the public URL locally', async () => {
        const fake = fakeR2(),
            storage = createMarkerStorage(account, fake.network),
            signal = new AbortController().signal;
        expect(await storage.uploadHeatmap('bookaria/heat.png', Buffer.from('png'), signal)).toBe(
            'https://assets.bookaria.test/bookaria/heat.png',
        );
        expect(fake.files.get('bookaria/heat.png')?.type).toBe('image/png');
        await expect(
            storage.uploadHeatmap('bookaria/heat.png', Buffer.from('changed'), signal),
        ).rejects.toThrow('ghi đè');
    });
    it('does not fetch after cancellation', async () => {
        const fake = fakeR2();
        await expect(
            createMarkerStorage(account, fake.network).download(
                { original_public_id: 'bookaria/page', page_aspect: 1 } as MarkerSource,
                AbortSignal.abort(),
            ),
        ).rejects.toThrow();
        expect(fake.network).not.toHaveBeenCalled();
    });
});
