import { describe, expect, it, vi } from 'vitest';
import type { AssetRow } from '../../../modules/assets/assets.types';
import { createProcessingStorage } from '../storage';

const account = { cloudName: 'bookaria-test', apiKey: 'key', apiSecret: 'secret' };
const model = {
    original_public_id: 'bookaria/user/model',
    resource_type: 'image',
} as AssetRow;

describe('processing storage', () => {
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
