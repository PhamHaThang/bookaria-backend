import { describe, expect, it } from 'vitest';
import { pageImageDelivery, pageImageTransform } from '../page-image';

describe('cached page image delivery', () => {
    it('uses bounded, exact paper dimensions and one deterministic JPEG transformation', () => {
        expect(pageImageTransform(14142 / 10000)).toMatchObject({ width: 1600, height: 2263 });
        expect(pageImageTransform(0.5)).toEqual({
            width: 1600,
            height: 800,
            transform: 'c_pad,w_1600,h_800,g_center,b_white,f_jpg,q_94',
        });
        expect(pageImageTransform(5)).toMatchObject({ width: 480, height: 2400 });
        for (const value of [NaN, Infinity, 0.1, 6])
            expect(() => pageImageTransform(value)).toThrow();
    });
    it('keeps the source identity in the derived URL and uses a smaller thumbnail transformation', () => {
        const calls: unknown[] = [];
        const storage = {
            deliveryUrl: (req: unknown) => {
                calls.push(req);
                return 'https://fake.test/layout.jpg';
            },
        };
        expect(pageImageDelivery(storage, 'original', 0.5)).toMatchObject({
            url: 'https://fake.test/layout.jpg',
            width: 1600,
            height: 800,
        });
        pageImageDelivery(storage, 'original', 0.5, true);
        expect(calls).toEqual([
            {
                resourceType: 'image',
                publicId: 'original',
                format: 'jpg',
                transform: 'c_pad,w_1600,h_800,g_center,b_white,f_jpg,q_94',
            },
            {
                resourceType: 'image',
                publicId: 'original',
                format: 'jpg',
                transform: 'c_pad,w_320,h_160,g_center,b_white,f_jpg,q_94',
            },
        ]);
    });
});
