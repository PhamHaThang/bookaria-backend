import { describe, expect, it } from 'vitest';
import { pageImageDelivery, pageImageTransform } from '../page-image';

describe('cached page image delivery', () => {
    it('uses bounded, exact paper dimensions and one deterministic JPEG transformation', () => {
        expect(pageImageTransform(14142 / 10000)).toMatchObject({ width: 1600, height: 2263 });
        expect(pageImageTransform(0.5)).toEqual({
            width: 1600,
            height: 800,
            transform: 'page-1600-800',
        });
        expect(pageImageTransform(1.51)).toMatchObject({ width: 1589, height: 2399 });
        expect(pageImageTransform(2.9)).toMatchObject({ width: 828, height: 2400 });
        expect(pageImageTransform(5)).toMatchObject({ width: 480, height: 2400 });
        for (const value of [NaN, Infinity, 0.1, 6])
            expect(() => pageImageTransform(value)).toThrow();
    });
    it('keeps the source identity in the derived URL and uses a smaller thumbnail transformation', async () => {
        const calls: unknown[] = [];
        const storage = {
            prepareImage: async (publicId: string, transform: string) => {
                calls.push({ publicId, transform });
                return 'https://fake.test/layout.jpg';
            },
        };
        expect(await pageImageDelivery(storage, 'original', 0.5)).toMatchObject({
            url: 'https://fake.test/layout.jpg',
            width: 1600,
            height: 800,
        });
        await pageImageDelivery(storage, 'original', 0.5, true);
        expect(calls).toEqual([
            {
                publicId: 'original',
                transform: 'page-1600-800',
            },
            {
                publicId: 'original',
                transform: 'page-320-160',
            },
        ]);
    });
});
