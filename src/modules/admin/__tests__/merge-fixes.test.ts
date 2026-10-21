// Regression tests for the merged admin module and existing worker/auth flows.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { createOptimizeHandler } from '../../../worker/optimize';
import type { ProcessingStorage } from '../../../worker/optimize/storage';
import { startQueueWorker } from '../../../worker/queue';
import { runJob } from '../../../worker/runner';
import { JobError } from '../../jobs/jobs.types';
import { adminRepository } from '../admin.repository';

const app = createApp({ rateLimit: false });
const password = 'Review-password-123';
async function user(admin = false) {
    const email = `review-${randomUUID()}@example.com`;
    const response = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password, displayName: 'Review' });
    expect(response.status).toBe(201);
    const id = response.body.data.user.id as string;
    let token = response.body.data.accessToken as string;
    if (admin) {
        await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [id]);
        const login = await request(app).post('/api/v1/auth/login').send({ email, password });
        expect(login.status).toBe(200);
        token = login.body.data.accessToken;
    }
    return { id, token };
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe.skipIf(Boolean(process.env.SKIP_DB_TESTS))('merge fix regressions', () => {
    it('rejects mutations with the access token of an author locked by admin', async () => {
        const admin = await user(true),
            author = await user();
        const locked = await request(app)
            .patch(`/api/v1/admin/users/${author.id}`)
            .set(auth(admin.token))
            .send({ status: 'LOCKED', reason: 'Review lock' });
        expect(locked.status).toBe(200);
        const sessions = await pool.query(
            'SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',
            [author.id],
        );
        expect(sessions.rows[0].n).toBe(0);
        const create = await request(app)
            .post('/api/v1/books')
            .set(auth(author.token))
            .send({ title: 'Created after account lock' });
        console.log(
            'LOCKED_AUTHOR',
            JSON.stringify({
                actual: create.status,
                bookId: create.body.data?.book?.id ?? create.body.data?.id,
            }),
        );
        expect(create.status).toBe(423);
    });

    it('rejects self demotion when the URL UUID uses upper-case letters', async () => {
        await user(true); // Keep another admin so LAST_ADMIN does not hide SELF_ACTION.
        const admin = await user(true);
        const res = await request(app)
            .patch(`/api/v1/admin/users/${admin.id.toUpperCase()}`)
            .set(auth(admin.token))
            .send({ role: 'AUTHOR', reason: 'Review self action' });
        const current = await pool.query('SELECT role FROM users WHERE id=$1', [admin.id]);
        console.log(
            'UPPERCASE_SELF',
            JSON.stringify({ actual: res.status, role: current.rows[0].role }),
        );
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('SELF_ACTION');
    });

    it('protects shared assets referenced only by a published version', async () => {
        const admin = await user(true),
            author = await user();
        const asset = randomUUID(),
            book = randomUUID(),
            version = randomUUID();
        await pool.query(
            `INSERT INTO assets(id,type,name,original_public_id,resource_type,format,size_bytes,status,license,author_name)
             VALUES ($1,'MODEL','Shared model','review/model','image','glb',1024,'READY','CC0','Artist')`,
            [asset],
        );
        await pool.query(
            "INSERT INTO books(id,owner_id,title) VALUES ($1,$2,'Published history')",
            [book, author.id],
        );
        await pool.query(
            `INSERT INTO book_versions(id,book_id,version_no,schema_version,manifest_public_id,mind_groups,page_count,ar_page_count,total_size_bytes)
             VALUES ($1,$2,1,1,'review/manifest.json','[]',1,1,1024)`,
            [version, book],
        );
        await pool.query('INSERT INTO version_assets(book_version_id,asset_id) VALUES ($1,$2)', [
            version,
            asset,
        ]);
        const res = await request(app)
            .delete(`/api/v1/admin/library/assets/${asset}`)
            .set(auth(admin.token));
        const row = await pool.query('SELECT deleted_at FROM assets WHERE id=$1', [asset]);
        console.log(
            'PUBLISHED_LIBRARY_ASSET',
            JSON.stringify({ actual: res.status, deleted: row.rows[0].deleted_at !== null }),
        );
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ASSET_IN_USE');
    });

    it('can actually process an optimization job after admin retries its failure', async () => {
        const admin = await user(true),
            author = await user();
        const asset = randomUUID(),
            job = randomUUID();
        await pool.query(
            `INSERT INTO assets(id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
             VALUES ($1,$2,'AUDIO','Audio','review/audio','video','mp3',1000,'PROCESSING')`,
            [asset, author.id],
        );
        await pool.query(
            "INSERT INTO jobs(id,type,ref_type,ref_id,created_by) VALUES ($1,'OPTIMIZE_ASSET','ASSET',$2,$3)",
            [job, asset, author.id],
        );
        expect(
            await runJob(job, async () => {
                throw new JobError('REVIEW_FAILURE', 'Previous failure');
            }),
        ).toBe('failed');
        const failedAsset = await pool.query('SELECT status FROM assets WHERE id=$1', [asset]);
        expect(failedAsset.rows[0].status).toBe('FAILED');
        const retry = await request(app)
            .post(`/api/v1/admin/jobs/${job}/retry`)
            .set(auth(admin.token));
        expect(retry.status).toBe(202);
        const storage: ProcessingStorage = {
            inspect: async () => ({ bytes: 1000, format: 'mp3', duration: 1 }),
            download: async () => Buffer.alloc(1000),
            uploadModel: async () => {},
            thumbnail: async () => 'https://example.com/thumb.jpg',
        };
        expect(retry.body.data.jobId).not.toBe(job);
        const outcome = await runJob(retry.body.data.jobId, createOptimizeHandler(storage));
        const state = await pool.query('SELECT status,error FROM jobs WHERE id=$1', [job]);
        console.log('RETRY_OPTIMIZE', JSON.stringify({ outcome, ...state.rows[0] }));
        expect(outcome).toBe('done');
    });

    it('keeps revoked tokens invalid after account unlock', async () => {
        const admin = await user(true),
            author = await user();
        for (const status of ['LOCKED', 'ACTIVE']) {
            const res = await request(app)
                .patch(`/api/v1/admin/users/${author.id}`)
                .set(auth(admin.token))
                .send({ status, reason: 'Review status' });
            expect(res.status).toBe(200);
        }
        const res = await request(app).get('/api/v1/books').set(auth(author.token));
        expect(res.status).toBe(401);
    });

    it('rejects expired sessions and uses the current database role', async () => {
        const admin = await user(true);
        const author = await user();
        await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [author.id]);
        expect((await request(app).get('/api/v1/admin/users').set(auth(author.token))).status).toBe(
            200,
        );
        await pool.query("UPDATE users SET role='AUTHOR' WHERE id=$1", [author.id]);
        expect((await request(app).get('/api/v1/admin/users').set(auth(author.token))).status).toBe(
            403,
        );
        await pool.query(
            "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
            [admin.id],
        );
        expect((await request(app).get('/api/v1/books').set(auth(admin.token))).status).toBe(401);
    });

    it('rolls back the replacement job and asset reset if audit insertion fails', async () => {
        const admin = await user(true),
            author = await user(),
            asset = randomUUID(),
            job = randomUUID();
        await pool.query(
            `INSERT INTO assets(id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
            VALUES ($1,$2,'AUDIO','Audio','rollback/audio','video','mp3',1000,'FAILED')`,
            [asset, author.id],
        );
        await pool.query(
            `INSERT INTO jobs(id,type,ref_type,ref_id,created_by,status,error)
            VALUES ($1,'OPTIMIZE_ASSET','ASSET',$2,$3,'FAILED','{"code":"FAIL","message":"failure"}')`,
            [job, asset, author.id],
        );
        const spy = vi
            .spyOn(adminRepository, 'insertAuditLog')
            .mockRejectedValueOnce(new Error('audit unavailable'));
        try {
            expect(
                (await request(app).post(`/api/v1/admin/jobs/${job}/retry`).set(auth(admin.token)))
                    .status,
            ).toBe(500);
        } finally {
            spy.mockRestore();
        }
        expect(
            (await pool.query('SELECT status FROM assets WHERE id=$1', [asset])).rows[0].status,
        ).toBe('FAILED');
        expect(
            (await pool.query('SELECT count(*)::int AS n FROM jobs WHERE ref_id=$1', [asset]))
                .rows[0].n,
        ).toBe(1);
    });

    it('dispatches a manual retry through pg-boss under a new identity', async () => {
        const admin = await user(true),
            author = await user(),
            asset = randomUUID(),
            job = randomUUID();
        await pool.query(
            `INSERT INTO assets(id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
            VALUES ($1,$2,'AUDIO','Audio','queue/audio','video','mp3',1000,'PROCESSING')`,
            [asset, author.id],
        );
        await pool.query(
            `INSERT INTO jobs(id,type,ref_type,ref_id,created_by)
            VALUES ($1,'OPTIMIZE_ASSET','ASSET',$2,$3)`,
            [job, asset, author.id],
        );
        const storage: ProcessingStorage = {
            inspect: async () => ({ bytes: 1000, format: 'mp3', duration: 1 }),
            download: async () => Buffer.alloc(1000),
            uploadModel: async () => {},
            thumbnail: async () => 'https://example.com/thumb.jpg',
        };
        const optimize = createOptimizeHandler(storage);
        const worker = await startQueueWorker({
            schema: `retry_${randomUUID().replaceAll('-', '')}`,
            dispatchEveryMs: 0,
            pollingSeconds: 0.5,
            retryDelaySeconds: 1,
            expireSeconds: 30,
            handlers: {
                OPTIMIZE_ASSET: async (ctx) => {
                    if (ctx.job.id === job)
                        throw new JobError('REVIEW_FAILURE', 'First failed job');
                    return optimize(ctx);
                },
            },
        });
        try {
            await vi.waitFor(
                async () => {
                    expect(
                        (await pool.query('SELECT status FROM jobs WHERE id=$1', [job])).rows[0]
                            .status,
                    ).toBe('FAILED');
                },
                { timeout: 8000, interval: 100 },
            );
            const replies = await Promise.all(
                [0, 1].map(() =>
                    request(app).post(`/api/v1/admin/jobs/${job}/retry`).set(auth(admin.token)),
                ),
            );
            expect(replies.map((r) => r.status).sort()).toEqual([202, 409]);
            const next = replies.find((r) => r.status === 202)?.body.data.jobId as string;
            expect(next).not.toBe(job);
            await worker.tick();
            await vi.waitFor(
                async () => {
                    expect(
                        (await pool.query('SELECT status FROM jobs WHERE id=$1', [next])).rows[0]
                            .status,
                    ).toBe('SUCCEEDED');
                },
                { timeout: 8000, interval: 100 },
            );
            expect(
                (await pool.query('SELECT status FROM jobs WHERE id=$1', [job])).rows[0].status,
            ).toBe('FAILED');
            expect(
                (await pool.query('SELECT status FROM assets WHERE id=$1', [asset])).rows[0].status,
            ).toBe('READY');
        } finally {
            await worker.stop();
        }
    });
});
