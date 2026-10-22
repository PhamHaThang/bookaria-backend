import { describe, expect, it, vi } from 'vitest';
import type { AssetRow } from '../../../modules/assets/assets.types';
import { createProcessingStorage } from '../storage';

const account = { cloudName: 'bookaria-test', apiKey: 'key', apiSecret: 'secret' };
const model = {
    original_public_id: 'bookaria/user/model',
    resource_type: 'image',
} as AssetRow;

describe('processing storage', () => {
    it('accepts Cloudinary audio with zero dimensions and keeps its duration', async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({
                bytes: 8044,
                format: 'wav',
                duration: 0.5,
                width: 0,
                height: 0,
            }),
        );
        const storage = createProcessingStorage(account, fetchImpl);
        await expect(
            storage.inspect(
                { ...model, type: 'AUDIO', resource_type: 'video' },
                new AbortController().signal,
            ),
        ).resolves.toEqual({
            bytes: 8044,
            format: 'wav',
            duration: 0.5,
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://api.cloudinary.com/v1_1/bookaria-test/resources/video/upload/bookaria/user/model?media_metadata=true',
            expect.any(Object),
        );
    });

    it.each([
        { bytes: 8044, format: 'wav', duration: -1, width: 0, height: 0 },
        { bytes: 0, format: 'wav', duration: 0.5, width: 0, height: 0 },
    ])('still rejects invalid audio metadata: %j', async (metadata) => {
        const storage = createProcessingStorage(
            account,
            vi.fn(async () => Response.json(metadata)),
        );
        await expect(
            storage.inspect({ ...model, type: 'AUDIO' }, new AbortController().signal),
        ).rejects.toMatchObject({
            code: 'INVALID_MEDIA_METADATA',
            retry: false,
        });
    });

    it('still rejects video with zero dimensions', async () => {
        const storage = createProcessingStorage(
            account,
            vi.fn(async () =>
                Response.json({
                    bytes: 8044,
                    format: 'mp4',
                    duration: 0.5,
                    width: 0,
                    height: 0,
                }),
            ),
        );
        await expect(
            storage.inspect({ ...model, type: 'VIDEO' }, new AbortController().signal),
        ).rejects.toMatchObject({ code: 'INVALID_MEDIA_METADATA' });
    });

    it('preserves valid video dimensions', async () => {
        const metadata = { bytes: 8044, format: 'mp4', duration: 0.5, width: 640, height: 480 };
        const storage = createProcessingStorage(
            account,
            vi.fn(async () => Response.json(metadata)),
        );
        await expect(
            storage.inspect({ ...model, type: 'VIDEO' }, new AbortController().signal),
        ).resolves.toEqual(metadata);
    });

    it('accepts model metadata without a media duration', async () => {
        const fetchImpl = vi.fn(async () => Response.json({ bytes: 1024, format: 'glb' }));
        const storage = createProcessingStorage(account, fetchImpl);

        await expect(storage.inspect(model, new AbortController().signal)).resolves.toEqual({
            bytes: 1024,
            format: 'glb',
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('rejects malformed metadata as a permanent job error', async () => {
        const storage = createProcessingStorage(
            account,
            vi.fn(async () => Response.json({ bytes: 'unknown', format: 'glb' })),
        );

        await expect(storage.inspect(model, new AbortController().signal)).rejects.toMatchObject({
            code: 'INVALID_MEDIA_METADATA',
            retry: false,
        });
    });
});
