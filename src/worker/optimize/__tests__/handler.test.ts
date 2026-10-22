import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '../../../db';
import type { AssetRow } from '../../../modules/assets/assets.types';
import type { JobContext, JobRow } from '../../../modules/jobs/jobs.types';
import { createOptimizeHandler } from '..';
import type { ProcessingStorage } from '../storage';

function fixture(type: AssetRow['type'] = 'MODEL') {
    const owner = randomUUID();
    const asset: AssetRow = {
        id: randomUUID(),
        owner_id: owner,
        category_id: null,
        type,
        name: 'Tài nguyên thử',
        original_public_id: `bookaria/${owner}/source`,
        resource_type: type === 'MODEL' ? 'image' : 'video',
        optimized_public_id: null,
        thumbnail_url: null,
        format: type === 'MODEL' ? 'glb' : type === 'AUDIO' ? 'mp3' : 'mp4',
        size_bytes: '3',
        status: 'PROCESSING',
        error: null,
        meta: {},
        tags: [],
        license: null,
        author_name: null,
        source_url: null,
        created_at: new Date(),
    };
    const job: JobRow = {
        id: randomUUID(),
        type: 'OPTIMIZE_ASSET',
        status: 'RUNNING',
        ref_type: 'ASSET',
        ref_id: asset.id,
        payload: {},
        result: null,
        progress: 0,
        attempts: 1,
        error: null,
        created_by: owner,
        created_at: new Date(),
        started_at: new Date(),
        finished_at: null,
    };
    let finalize: ((db: Queryable) => Promise<void>) | undefined;
    const context: JobContext = {
        job,
        signal: new AbortController().signal,
        setProgress: vi.fn(async () => {}),
        onSuccess: (callback) => {
            finalize = callback;
        },
    };
    const repository = {
        getAssetById: vi.fn(async () => asset),
        saveReady: vi.fn(async () => {}),
    };
    const storage = {
        inspect: vi.fn(async () => ({
            bytes: 3,
            format: asset.format,
            duration: 1,
            width: 2,
            height: 2,
        })),
        download: vi.fn(async () => Buffer.from([1, 2, 3])),
        uploadModel: vi.fn(async () => {}),
        thumbnail: vi.fn(async () => 'https://example.com/thumb.jpg'),
    } satisfies ProcessingStorage;
    return { asset, context, repository, storage, getFinalize: () => finalize };
}

describe('createOptimizeHandler', () => {
    it('returns legacy READY audio without spatial dimensions', async () => {
        const f = fixture('AUDIO');
        f.asset.status = 'READY';
        f.asset.meta = { width: 0, height: 0, durationSec: 1, purpose: 'ASSET' };
        const handler = createOptimizeHandler(f.storage, undefined, f.repository);
        await expect(handler(f.context)).resolves.toEqual({
            assetId: f.asset.id,
            meta: { durationSec: 1, purpose: 'ASSET' },
        });
        expect(f.storage.inspect).not.toHaveBeenCalled();
    });

    it('rejects a model whose source changed before downloading', async () => {
        const f = fixture();
        f.storage.inspect.mockResolvedValue({
            bytes: 4,
            format: 'glb',
            duration: 1,
            width: 2,
            height: 2,
        });
        const handler = createOptimizeHandler(f.storage, undefined, f.repository);

        await expect(handler(f.context)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        expect(f.storage.download).not.toHaveBeenCalled();
        expect(f.getFinalize()).toBeUndefined();
    });

    it('rejects a model whose download length differs from verified metadata', async () => {
        const f = fixture();
        f.storage.download.mockResolvedValue(Buffer.from([1, 2]));
        const handler = createOptimizeHandler(f.storage, undefined, f.repository);

        await expect(handler(f.context)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
        expect(f.storage.uploadModel).not.toHaveBeenCalled();
    });

    it('registers the asset update only after a successful model upload', async () => {
        const f = fixture();
        const modelProcessor = vi.fn(async () => ({
            bytes: new Uint8Array([1, 2]),
            meta: {
                triangles: 1,
                originalTriangles: 1,
                animations: [],
                downloadBytes: 2,
                geometryCompression: 'draco' as const,
                warnings: [],
            },
        }));
        const handler = createOptimizeHandler(f.storage, modelProcessor, f.repository);

        const result = await handler(f.context);
        expect(result).toMatchObject({ assetId: f.asset.id, meta: { downloadBytes: 2 } });
        expect(f.storage.uploadModel).toHaveBeenCalledOnce();
        expect(f.repository.saveReady).not.toHaveBeenCalled();
        const finalize = f.getFinalize();
        expect(finalize).toBeDefined();
        const db = {} as Queryable;
        await finalize?.(db);
        expect(f.repository.saveReady).toHaveBeenCalledWith(
            db,
            f.asset,
            expect.objectContaining({ optimizedPublicId: expect.any(String) }),
        );
    });

    it('rejects audio without a positive duration', async () => {
        const f = fixture('AUDIO');
        f.storage.inspect.mockResolvedValue({
            bytes: 3,
            format: 'mp3',
            duration: 0,
            width: 2,
            height: 2,
        });
        const handler = createOptimizeHandler(f.storage, undefined, f.repository);

        await expect(handler(f.context)).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
        expect(f.getFinalize()).toBeUndefined();
    });
});
