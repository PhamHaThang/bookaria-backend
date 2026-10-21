import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { optimizeRepository } from '../../../worker/optimize/repo';
import { jobsRepository } from '../../jobs/jobs.repository';
import { adminRepository } from '../admin.repository';

it('retry open-job check does not deadlock with worker finalization', async () => {
    const res = await request(createApp({ rateLimit: false }))
        .post('/api/v1/auth/register')
        .send({
            email: `lock-${randomUUID()}@example.com`,
            password: 'Review-password-123',
            displayName: 'Lock probe',
        });
    expect(res.status).toBe(201);
    const owner = res.body.data.user.id;
    const asset = randomUUID(),
        failed = randomUUID(),
        running = randomUUID();
    await pool.query(
        `INSERT INTO assets(id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
      VALUES ($1,$2,'AUDIO','Probe','review/probe','video','mp3',1000,'PROCESSING')`,
        [asset, owner],
    );
    await pool.query(
        `INSERT INTO jobs(id,type,ref_type,ref_id,created_by,status)
      VALUES ($1,'OPTIMIZE_ASSET','ASSET',$3,$4,'FAILED'),($2,'OPTIMIZE_ASSET','ASSET',$3,$4,'RUNNING')`,
        [failed, running, asset, owner],
    );
    const worker = await pool.connect(),
        admin = await pool.connect();
    try {
        await worker.query('BEGIN');
        await admin.query('BEGIN');
        await worker.query("SET LOCAL deadlock_timeout='100ms'");
        await admin.query("SET LOCAL deadlock_timeout='100ms'");
        await worker.query("SET LOCAL statement_timeout='5s'");
        await admin.query("SET LOCAL statement_timeout='5s'");
        // Same order as runner.isCurrentAttempt followed by optimize.saveReady.
        await jobsRepository.lockJob(worker, running);
        // Same order as retryFailedJob: failed job, domain asset, then open jobs.
        await jobsRepository.lockJob(admin, failed);
        await admin.query('SELECT owner_id FROM assets WHERE id=$1 FOR UPDATE', [asset]);
        const pid = (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let completed = false;
        const check = adminRepository
            .hasOpenJobForRef(admin, 'ASSET', asset, failed)
            .then(
                (v) => ({ value: v, code: null as string | null }),
                (e) => ({ value: false, code: e.code as string }),
            )
            .finally(() => {
                completed = true;
            });
        // Ensure the conflicting SELECT is waiting before worker updates the asset.
        for (let i = 0; i < 100 && !completed; i++) {
            const q = await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid]);
            if (q.rows[0].n > 0) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const original = await optimizeRepository.getAssetById(pool, asset);
        const save = optimizeRepository
            .saveReady(worker, original, {
                optimizedPublicId: null,
                thumbnailUrl: null,
                format: 'mp3',
                meta: { durationSec: 1, downloadBytes: 1000 },
            })
            .then(
                () => ({ code: null as string | null }),
                (e) => ({ code: e.code as string }),
            );
        const checked = await check;
        await admin.query('ROLLBACK');
        const saved = await save;
        console.log('LOCK_ORDER_RESULT', JSON.stringify({ checked, saved }));
        expect(checked.code).toBeNull();
        expect(checked.value).toBe(true);
        expect(saved.code).toBeNull();
    } finally {
        await admin.query('ROLLBACK');
        await worker.query('ROLLBACK');
        admin.release();
        worker.release();
    }
}, 15000);
