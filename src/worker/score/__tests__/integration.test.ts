import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { env } from '../../../config';
import { pool, withTransaction } from '../../../db';
import { type MediaStorage, setMediaStorage } from '../../../lib';
import { JobError } from '../../../modules/jobs/jobs.types';
import { pagesRepository } from '../../../modules/pages/pages.repository';
import { publishService } from '../../../modules/publish/publish.service';
import { handlers } from '../../handlers';
import { failAbandonedJob, runJob } from '../../runner';
import { createScoreMarkerHandler } from '..';
import { scoreRepository } from '../repo';
import type { MarkerStorage } from '../storage';
import type { MarkerAnalysis } from '../types';
import { illustration } from './fixtures';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const fakeMedia: MediaStorage = {
    signUpload() {
        throw new Error('not used');
    },
    async inspect(_type, publicId) {
        return { publicId, bytes: 100, format: '', width: null, height: null, durationSec: null };
    },
    async destroy() {},
    deliveryUrl: ({ publicId }) => `https://example.com/${publicId}`,
};

async function setup(count = 2) {
    const registered = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `score-${randomUUID()}@example.com`,
            displayName: 'Tác giả',
            password: 'Matkhau-123',
        });
    expect(registered.status).toBe(201);
    const userId = registered.body.data.user.id as string;
    const token = registered.body.data.accessToken as string;
    const bookId = randomUUID();
    await pool.query("INSERT INTO books (id, owner_id, title) VALUES ($1,$2,'WK04')", [
        bookId,
        userId,
    ]);
    await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [userId]);
    const pages: string[] = [];
    const assets: string[] = [];
    for (let i = 0; i < count; i++) {
        const assetId = randomUUID();
        const pageId = randomUUID();
        await pool.query(
            `INSERT INTO assets (id, owner_id, type, name, original_public_id, resource_type, format, size_bytes, status, meta)
            VALUES ($1,$2,'IMAGE','trang',$3,'image','png',3,'READY','{"width":640,"height":640}')`,
            [assetId, userId, `bookaria/${userId}/${assetId}`],
        );
        await pool.query(
            `INSERT INTO pages (id, book_id, order_index, image_asset_id, marker_mode, marker_mind_public_id)
            VALUES ($1,$2,$3,$4,'CUSTOM_MARKER',$5)`,
            [pageId, bookId, i, assetId, `bookaria/${userId}/${pageId}.mind`],
        );
        pages.push(pageId);
        assets.push(assetId);
    }
    const target = pages[0] as string;
    const job = await pool.query<{ id: string }>(
        "INSERT INTO jobs (type, ref_type, ref_id, created_by) VALUES ('SCORE_MARKER','PAGE',$1,$2) RETURNING id",
        [target, userId],
    );
    return {
        userId,
        token,
        bookId,
        target,
        peer: pages[1] as string,
        pages,
        assets,
        jobId: job.rows[0]?.id as string,
    };
}
const pageState = async (id: string) =>
    (await pool.query('SELECT * FROM pages WHERE id=$1', [id])).rows[0];
const jobState = async (id: string) =>
    (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
function fakePipeline(similarity = 0.8) {
    const analysis: MarkerAnalysis = {
        width: 640,
        height: 640,
        png: Buffer.from('png'),
        digest: 'test',
        points: [],
        descriptors: new Uint8Array(),
        cells: Array(16).fill(10),
        features: 180,
        coverage: 0.75,
        score: 3,
        hints: ['Ngưỡng thử nghiệm.'],
    };
    const storage: MarkerStorage = {
        download: vi.fn(async () => Buffer.from('png')),
        uploadHeatmap: vi.fn(async (publicId) => `https://example.com/${publicId}.png`),
    };
    const processor = {
        analyze: vi.fn(async () => analysis),
        compare: vi.fn(async () => similarity),
        heatmap: vi.fn(async () => Buffer.from('png')),
    };
    return { storage, processor, handler: createScoreMarkerHandler(storage, processor) };
}

suite('SCORE_MARKER integration', () => {
    beforeAll(() => setMediaStorage(fakeMedia));
    afterAll(() => setMediaStorage(undefined));
    it('keeps OPTIMIZE_ASSET and registers SCORE_MARKER', () => {
        expect(typeof handlers.OPTIMIZE_ASSET).toBe('function');
        expect(typeof handlers.SCORE_MARKER).toBe('function');
    });
    it('commits the report and job atomically, exposes reciprocal warnings via HTTP', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        expect(await runJob(s.jobId, pipeline.handler)).toBe('done');
        expect(await jobState(s.jobId)).toMatchObject({
            status: 'SUCCEEDED',
            progress: 100,
            result: { pageId: s.target, score: 3 },
        });
        const target = await pageState(s.target);
        expect(target).toMatchObject({ marker_score: 3, marker_features: 180, revision: 0 });
        expect(target.marker_report.similarPages).toEqual([{ pageId: s.peer, similarity: 0.8 }]);
        const peer = await pageState(s.peer);
        expect(peer.marker_score).toBeNull();
        expect(peer.marker_report.similarPages).toEqual([{ pageId: s.target, similarity: 0.8 }]);
        const response = await request(app)
            .get(`/api/v1/pages/${s.peer}/marker`)
            .auth(s.token, { type: 'bearer' });
        expect(response.status).toBe(200);
        expect(response.body.data.markerWarnings).toEqual(
            expect.arrayContaining(['NOT_SCORED', `SIMILAR_TO:${s.target}`]),
        );
        const check = await publishService.publishCheck(s.userId, s.bookId);
        expect(check.warnings.filter((w) => w.code === 'PAGE_SIMILAR')).toHaveLength(1);
    });
    it('runs real ORB and PNG generation through the handler and database', async () => {
        const s = await setup(1);
        const input = await illustration();
        const storage: MarkerStorage = {
            download: async () => input,
            uploadHeatmap: async (_id, png) => {
                expect(png.subarray(1, 4).toString()).toBe('PNG');
                return 'https://example.com/heatmap.png';
            },
        };
        expect(await runJob(s.jobId, createScoreMarkerHandler(storage))).toBe('done');
        expect((await pageState(s.target)).marker_features).toBeGreaterThan(100);
    });
    it('can execute via a real isolated pg-boss queue', async () => {
        const s = await setup(1);
        const boss = new PgBoss({
            connectionString: env.DATABASE_URL,
            schema: 'pgboss_hd16_score',
            schedule: false,
        });
        const pipeline = fakePipeline();
        try {
            await boss.start();
            await boss.createQueue('SCORE_MARKER');
            await boss.work<{ jobId: string }>(
                'SCORE_MARKER',
                { batchSize: 1, pollingIntervalSeconds: 0.5 },
                async ([job]) => {
                    if (job) await runJob(job.data.jobId, pipeline.handler, job.signal);
                },
            );
            await boss.send('SCORE_MARKER', { jobId: s.jobId });
            await vi.waitFor(
                async () => expect((await jobState(s.jobId)).status).toBe('SUCCEEDED'),
                { timeout: 10_000 },
            );
        } finally {
            await boss.stop({ graceful: true, timeout: 8000 });
        }
    });
    it('rejects another owner before downloading', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        await pool.query('UPDATE jobs SET created_by=NULL WHERE id=$1', [s.jobId]);
        expect(await runJob(s.jobId, pipeline.handler)).toBe('failed');
        expect(pipeline.storage.download).not.toHaveBeenCalled();
        expect((await pageState(s.target)).marker_score).toBeNull();
    });
    it('only compares Custom pages of the same book', async () => {
        const s = await setup(3);
        const other = await setup(1);
        const pipeline = fakePipeline();
        await withTransaction(async (db) =>
            pagesRepository.setBookariaMarker(db, s.pages[2] as string, null),
        );
        await runJob(s.jobId, pipeline.handler);
        expect(pipeline.storage.download).toHaveBeenCalledTimes(2);
        expect((await pageState(other.target)).marker_report).toBeNull();
    });
    it('cannot write a score after the target changes mode during upload', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        vi.mocked(pipeline.storage.uploadHeatmap).mockImplementation(async () => {
            await withTransaction((db) => pagesRepository.setBookariaMarker(db, s.target, null));
            return 'https://example.com/old.png';
        });
        expect(await runJob(s.jobId, pipeline.handler)).toBe('failed');
        expect(await pageState(s.target)).toMatchObject({
            marker_mode: 'NONE',
            marker_score: null,
            marker_report: null,
        });
        expect((await jobState(s.jobId)).error.code).toBe('STALE_MARKER');
    });
    it('cannot write after a target image change', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        vi.mocked(pipeline.storage.uploadHeatmap).mockImplementation(async () => {
            await pool.query('UPDATE pages SET image_asset_id=$2 WHERE id=$1', [
                s.target,
                s.assets[1],
            ]);
            return 'https://example.com/old.png';
        });
        expect(await runJob(s.jobId, pipeline.handler)).toBe('failed');
        expect((await pageState(s.target)).marker_score).toBeNull();
    });
    it('does not restore a deleted page', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        vi.mocked(pipeline.storage.uploadHeatmap).mockImplementation(async () => {
            await pool.query('DELETE FROM pages WHERE id=$1', [s.target]);
            return 'https://example.com/old.png';
        });
        expect(await runJob(s.jobId, pipeline.handler)).toBe('failed');
        expect(await pageState(s.target)).toBeUndefined();
    });
    it('retries when another Custom page changes during comparison', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        vi.mocked(pipeline.storage.uploadHeatmap).mockImplementationOnce(async () => {
            await pool.query('UPDATE pages SET image_asset_id=$2 WHERE id=$1', [
                s.peer,
                s.assets[0],
            ]);
            return 'https://example.com/retry.png';
        });
        await expect(runJob(s.jobId, pipeline.handler)).rejects.toThrow();
        expect((await jobState(s.jobId)).status).toBe('QUEUED');
        expect((await pageState(s.target)).marker_score).toBeNull();
        expect(await runJob(s.jobId, pipeline.handler)).toBe('done');
    });
    it('ignores an older attempt and leaves no reciprocal report', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        vi.mocked(pipeline.storage.uploadHeatmap).mockImplementation(async () => {
            await pool.query('UPDATE jobs SET attempts=2 WHERE id=$1', [s.jobId]);
            return 'https://example.com/old.png';
        });
        expect(await runJob(s.jobId, pipeline.handler)).toBe('skipped');
        expect((await pageState(s.target)).marker_report).toBeNull();
        expect((await pageState(s.peer)).marker_report).toBeNull();
    });
    it('rolls back both reports when SQL commit fails', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        const repository = {
            ...scoreRepository,
            async saveResult(...args: Parameters<typeof scoreRepository.saveResult>) {
                await scoreRepository.saveResult(...args);
                throw new JobError('COMMIT_FAILED', 'Lỗi ghi kết quả.');
            },
        };
        await runJob(
            s.jobId,
            createScoreMarkerHandler(pipeline.storage, pipeline.processor, repository),
        );
        expect((await pageState(s.target)).marker_report).toBeNull();
        expect((await pageState(s.peer)).marker_report).toBeNull();
        expect((await jobState(s.jobId)).status).toBe('FAILED');
    });
    it('does not commit after cancellation', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        const controller = new AbortController();
        vi.mocked(pipeline.storage.uploadHeatmap).mockImplementation(async () => {
            controller.abort();
            return 'https://example.com/cancelled.png';
        });
        await expect(runJob(s.jobId, pipeline.handler, controller.signal)).rejects.toThrow();
        expect((await pageState(s.target)).marker_score).toBeNull();
    });
    it('keeps a failed scoring job from marking a READY image FAILED', async () => {
        const s = await setup(1);
        const pipeline = fakePipeline();
        vi.mocked(pipeline.storage.download).mockRejectedValue(
            new JobError('NETWORK', 'Mất mạng.', true),
        );
        await expect(runJob(s.jobId, pipeline.handler)).rejects.toThrow();
        await expect(runJob(s.jobId, pipeline.handler)).rejects.toThrow();
        expect(await runJob(s.jobId, pipeline.handler)).toBe('failed');
        expect((await pageState(s.target)).marker_score).toBeNull();
        expect(
            (await pool.query('SELECT status FROM assets WHERE id=$1', [s.assets[0]])).rows[0]
                .status,
        ).toBe('READY');
    });
    it('reaper settles scoring without inventing a score', async () => {
        const s = await setup(1);
        await pool.query(
            "UPDATE jobs SET status='RUNNING', attempts=3, started_at=now()-interval '1 hour' WHERE id=$1",
            [s.jobId],
        );
        expect(await failAbandonedJob(s.jobId, 60)).toBe(true);
        expect((await pageState(s.target)).marker_score).toBeNull();
    });
    it('does not mark a published book CHANGED just for scoring metadata', async () => {
        const s = await setup();
        const pipeline = fakePipeline();
        await pool.query("UPDATE books SET status='PUBLISHED', slug=$2 WHERE id=$1", [
            s.bookId,
            `book-${s.bookId}`,
        ]);
        await runJob(s.jobId, pipeline.handler);
        expect(
            (await pool.query('SELECT status FROM books WHERE id=$1', [s.bookId])).rows[0].status,
        ).toBe('PUBLISHED');
        expect((await pageState(s.target)).revision).toBe(0);
    });
    it('rescore clears old score and references while pending, then removes a no-longer-similar pair', async () => {
        const s = await setup();
        await runJob(s.jobId, fakePipeline().handler);
        const res = await request(app)
            .post(`/api/v1/pages/${s.target}/marker/rescore`)
            .auth(s.token, { type: 'bearer' });
        expect(res.status).toBe(202);
        expect((await pageState(s.target)).marker_score).toBeNull();
        expect((await pageState(s.peer)).marker_report.similarPages).toEqual([]);
        expect((await publishService.publishCheck(s.userId, s.bookId)).errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'PAGE_NOT_SCORED', pageId: s.target }),
            ]),
        );
        await runJob(res.body.data.jobId, fakePipeline(0.1).handler);
        expect((await pageState(s.target)).marker_report.similarPages).toEqual([]);
        expect((await pageState(s.peer)).marker_report.similarPages).toEqual([]);
    });
    it.each(['noAr', 'delete', 'replace'])(
        'clears stale reciprocal references on %s',
        async (action) => {
            const s = await setup();
            await runJob(s.jobId, fakePipeline().handler);
            let response: request.Response;
            if (action === 'noAr')
                response = await request(app)
                    .patch(`/api/v1/pages/${s.target}`)
                    .auth(s.token, { type: 'bearer' })
                    .send({ noAr: true });
            else if (action === 'delete')
                response = await request(app)
                    .delete(`/api/v1/pages/${s.target}`)
                    .auth(s.token, { type: 'bearer' });
            else
                response = await request(app)
                    .put(`/api/v1/pages/${s.target}/image`)
                    .auth(s.token, { type: 'bearer' })
                    .send({
                        imageAssetId: s.assets[1],
                        markerMindPublicId: `bookaria/${s.userId}/replacement.mind`,
                    });
            expect([200, 204]).toContain(response.status);
            expect((await pageState(s.peer)).marker_report.similarPages).toEqual([]);
        },
    );
    it('returns 409 for replacing an image while its scoring job is open', async () => {
        const s = await setup();
        const response = await request(app)
            .put(`/api/v1/pages/${s.target}/image`)
            .auth(s.token, { type: 'bearer' })
            .send({
                imageAssetId: s.assets[1],
                markerMindPublicId: `bookaria/${s.userId}/replacement.mind`,
            });
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('JOB_IN_PROGRESS');
        expect((await pageState(s.target)).image_asset_id).toBe(s.assets[0]);
    });
});
