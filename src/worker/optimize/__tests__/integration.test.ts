import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { JobError } from '../../../modules/jobs/jobs.types';
import { silentWav } from '../../../test/media';
import { account, fakeR2 } from '../../../test/r2';
import { failAbandonedJob, runJob } from '../../runner';
import { createOptimizeHandler } from '..';
import { optimizeRepository } from '../repo';
import { createProcessingStorage, type ProcessingStorage } from '../storage';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });

async function makeJob() {
    const registered = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `optimize-${randomUUID()}@example.com`,
            displayName: 'Tác giả',
            password: 'Matkhau-123',
        });
    expect(registered.status).toBe(201);
    const ownerId = registered.body.data.user.id as string;
    const asset = await pool.query<{ id: string }>(
        `INSERT INTO assets
         (owner_id, type, name, original_public_id, resource_type, format, size_bytes, status)
         VALUES ($1, 'MODEL', 'Mô hình thử', $2, 'image', 'glb', 3, 'PROCESSING')
         RETURNING id`,
        [ownerId, `bookaria/${ownerId}/${randomUUID()}`],
    );
    const assetId = (asset.rows[0] as { id: string }).id;
    const job = await pool.query<{ id: string }>(
        `INSERT INTO jobs (type, ref_type, ref_id, created_by)
         VALUES ('OPTIMIZE_ASSET', 'ASSET', $1, $2) RETURNING id`,
        [assetId, ownerId],
    );
    return { assetId, ownerId, jobId: (job.rows[0] as { id: string }).id };
}

function fakeProcessing() {
    const storage = {
        inspect: vi.fn(async () => ({ bytes: 3, format: 'glb' })),
        download: vi.fn(async () => Buffer.from([1, 2, 3])),
        uploadModel: vi.fn(async () => {}),
        thumbnail: vi.fn(async () => 'https://example.com/thumbnail.jpg'),
    } satisfies ProcessingStorage;
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
    return { storage, modelProcessor };
}

async function state(assetId: string, jobId: string) {
    const asset = await pool.query<{
        status: string;
        optimized_public_id: string | null;
        error: string | null;
        meta: Record<string, unknown>;
    }>('SELECT status, optimized_public_id, error, meta FROM assets WHERE id = $1', [assetId]);
    const job = await pool.query<{ status: string; result: Record<string, unknown> | null }>(
        'SELECT status, result FROM jobs WHERE id = $1',
        [jobId],
    );
    return { asset: asset.rows[0], job: job.rows[0] };
}

suite('OPTIMIZE_ASSET transaction', () => {
    it('processes R2 WAV and removes legacy zero dimensions from asset and job result', async () => {
        const { assetId, jobId } = await makeJob();
        await pool.query(
            `UPDATE assets SET type = 'AUDIO', resource_type = 'video', format = 'wav',
            size_bytes = 8044, meta = $2::jsonb WHERE id = $1`,
            [
                assetId,
                JSON.stringify({ width: 0, height: 0, purpose: 'ASSET', custom: 'retained' }),
            ],
        );
        const fake = fakeR2();
        const source = await pool.query('SELECT original_public_id FROM assets WHERE id=$1', [
            assetId,
        ]);
        fake.files.set(source.rows[0].original_public_id, {
            bytes: silentWav(),
            type: 'audio/wav',
            format: 'wav',
        });
        const storage = createProcessingStorage(account, fake.network);
        expect(await runJob(jobId, createOptimizeHandler(storage))).toBe('done');
        const result = await state(assetId, jobId);
        const meta = {
            purpose: 'ASSET',
            custom: 'retained',
            durationSec: 0.5,
            downloadBytes: 8044,
        };
        expect(result.asset).toMatchObject({ status: 'READY', error: null });
        expect(result.asset?.meta).toEqual(meta);
        expect(result.job).toEqual({ status: 'SUCCEEDED', result: { assetId, meta } });
    });

    it('commits READY and SUCCEEDED together', async () => {
        const { assetId, jobId, ownerId } = await makeJob();
        const { storage, modelProcessor } = fakeProcessing();

        expect(await runJob(jobId, createOptimizeHandler(storage, modelProcessor))).toBe('done');
        expect(await state(assetId, jobId)).toMatchObject({
            asset: {
                status: 'READY',
                optimized_public_id: expect.stringContaining(`/processed/${assetId}/`),
                meta: { downloadBytes: 2 },
            },
            job: { status: 'SUCCEEDED', result: { assetId, meta: { downloadBytes: 2 } } },
        });
        expect(
            (await pool.query('SELECT id FROM notifications WHERE user_id=$1', [ownerId])).rowCount,
        ).toBe(0);
    });

    it.each(['success', 'failure'] as const)(
        'notifies the model author once after optimization %s',
        async (outcome) => {
            const { assetId, jobId, ownerId } = await makeJob();
            await pool.query(
                `INSERT INTO jobs (type,ref_type,ref_id,created_by,status,payload)
                 VALUES ('GENERATE_MODEL','ASSET',$1,$2,'SUCCEEDED','{"modelInputName":"Rùa"}'::jsonb)`,
                [assetId, ownerId],
            );
            const { storage, modelProcessor } = fakeProcessing();
            if (outcome === 'failure')
                modelProcessor.mockRejectedValue(
                    new JobError('INVALID_MODEL', 'GLB không hợp lệ.'),
                );
            const handler = createOptimizeHandler(storage, modelProcessor);
            expect(await runJob(jobId, handler)).toBe(outcome === 'success' ? 'done' : 'failed');
            expect(await runJob(jobId, handler)).toBe('skipped');
            const notices = await pool.query(
                'SELECT type,title,body,link FROM notifications WHERE user_id=$1',
                [ownerId],
            );
            expect(notices.rows).toEqual([
                {
                    type: outcome === 'success' ? 'JOB_SUCCEEDED' : 'JOB_FAILED',
                    title:
                        outcome === 'success'
                            ? 'Mô hình 3D đã sẵn sàng'
                            : 'Tạo mô hình 3D không thành công',
                    body:
                        outcome === 'success'
                            ? '“Rùa” đã được tạo và tối ưu. Bạn có thể thêm vào trang.'
                            : 'Chưa hoàn tất mô hình “Rùa”. Mở để xem chi tiết lỗi.',
                    link: `/assets?type=MODEL&asset=${assetId}`,
                },
            ]);
        },
    );

    it('rolls back the asset update when the success callback fails', async () => {
        const { assetId, jobId } = await makeJob();
        const { storage, modelProcessor } = fakeProcessing();
        const repository = {
            getAssetById: optimizeRepository.getAssetById,
            saveReady: async (...args: Parameters<typeof optimizeRepository.saveReady>) => {
                await optimizeRepository.saveReady(...args);
                throw new JobError('FINALIZE_FAILED', 'Không thể hoàn tất tài nguyên.');
            },
        };

        expect(
            await runJob(jobId, createOptimizeHandler(storage, modelProcessor, repository)),
        ).toBe('failed');
        expect(await state(assetId, jobId)).toMatchObject({
            asset: { status: 'FAILED', optimized_public_id: null },
            job: { status: 'FAILED', result: null },
        });
    });

    it('marks the asset failed when the last attempt expires', async () => {
        const { assetId, jobId } = await makeJob();
        await pool.query(
            "UPDATE jobs SET status = 'RUNNING', attempts = 3, started_at = now() - interval '1 hour' WHERE id = $1",
            [jobId],
        );

        expect(await failAbandonedJob(jobId, 60)).toBe(true);
        expect(await state(assetId, jobId)).toMatchObject({
            asset: { status: 'FAILED' },
            job: { status: 'FAILED' },
        });
    });
});
