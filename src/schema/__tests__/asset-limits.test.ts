import { describe, expect, it } from 'vitest';
import { ASSET_MAX_BYTES, checkUploadRequest } from '../api/assets.schema';
import { MODEL_MAX_DOWNLOAD_BYTES } from '../asset.schema';
import { MB } from '../common.schema';

describe('asset upload budgets', () => {
    it.each([
        ['ASSET', 'model.glb', 'model/gltf-binary', 50],
        ['ASSET', 'model.gltf', 'model/gltf+json', 50],
        ['ASSET', 'image.png', 'image/png', 10],
        ['ASSET', 'audio.mp3', 'audio/mpeg', 100],
        ['ASSET', 'video.mp4', 'video/mp4', 100],
        ['PAGE_IMAGE', 'page.jpg', 'image/jpeg', 10],
        ['AVATAR', 'avatar.webp', 'image/webp', 2],
        ['MARKER_MIND', 'page.mind', 'application/octet-stream', 5],
    ] as const)('bounds %s %s (%s) at %i MiB', (purpose, fileName, mimeType, megabytes) => {
        const request = { purpose, fileName, mimeType };
        const maximum = megabytes * MB;
        const check = checkUploadRequest({ ...request, sizeBytes: maximum });
        expect(check).toMatchObject({ ok: true, maxBytes: maximum });
        expect(checkUploadRequest({ ...request, sizeBytes: maximum + 1 })).toEqual({
            ok: false,
            code: 'FILE_TOO_LARGE',
            maxBytes: maximum,
        });
    });
    it('separates source-model upload bytes from the compressed runtime budget', () => {
        expect(ASSET_MAX_BYTES.MODEL).toBe(50 * MB);
        expect(MODEL_MAX_DOWNLOAD_BYTES).toBe(10 * MB);
    });
});
