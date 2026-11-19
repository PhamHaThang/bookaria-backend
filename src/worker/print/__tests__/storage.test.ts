import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { account, fakeR2 } from '../../../test/r2';
import { createPrintStorage, MAX_IMAGE_BYTES } from '../storage';

describe('R2 PDF image storage', () => {
    it('reads exact original bytes and uses the frozen paper geometry for derived JPEGs', async () => {
        const fake = fakeR2();
        const bytes = await sharp({
            create: { width: 200, height: 200, channels: 3, background: 'red' },
        })
            .png()
            .toBuffer();
        fake.files.set('bookaria/page', { bytes, type: 'image/png', format: 'png' });
        const storage = createPrintStorage(account, fake.network),
            signal = new AbortController().signal;
        expect(
            await storage.download({ publicId: 'bookaria/page', format: 'png' }, signal),
        ).toEqual(bytes);
        const derived = await storage.download(
            { publicId: 'bookaria/page', format: 'png', pageAspect: 0.5 },
            signal,
        );
        expect(await sharp(derived).metadata()).toMatchObject({
            format: 'jpeg',
            width: 1600,
            height: 800,
        });
        const before = fake.network.mock.calls.length;
        expect(
            await storage.download(
                { publicId: 'bookaria/page', format: 'png', pageAspect: 0.5 },
                signal,
            ),
        ).toEqual(derived);
        expect(
            fake.network.mock.calls
                .slice(before)
                .some((call) => (call[0] as Request).method === 'PUT'),
        ).toBe(false);
    });
    it('rejects missing, oversized and cancelled reads', async () => {
        const fake = fakeR2(),
            storage = createPrintStorage(account, fake.network),
            file = { publicId: 'missing', format: 'png' };
        await expect(storage.download(file, new AbortController().signal)).rejects.toThrow();
        fake.files.set('missing', {
            bytes: new Uint8Array(MAX_IMAGE_BYTES + 1),
            type: 'image/png',
            format: 'png',
        });
        await expect(storage.download(file, new AbortController().signal)).rejects.toThrow(
            'giới hạn',
        );
        const before = fake.network.mock.calls.length;
        await expect(storage.download(file, AbortSignal.abort())).rejects.toThrow();
        expect(fake.network.mock.calls).toHaveLength(before);
    });
});
