import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { decode } from '@msgpack/msgpack';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { errorMiddleware } from '../../../middlewares';
import { JobError, type JobHandler } from '../../../modules/jobs/jobs.types';
import { publicPreviewRouter } from '../../../modules/previews/preview.routes';
import { createPreview, createPreviewReader } from '../../../modules/previews/preview.service';
import { ManifestSchema } from '../../../schema';
import { handlers } from '../../handlers';
import type { PublishStorage } from '../../publish/storage';
import { runJob } from '../../runner';
import { createBuildPreviewHandler } from '..';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const real = readFileSync(new URL('../../publish/__tests__/fixtures/card.mind', import.meta.url));
const url: PublishStorage['url'] = ({ publicId }) => `https://cdn.example.com/${publicId}`;
async function setup(count = 1) {
    const auth = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `preview-${randomUUID()}@example.com`,
            password: 'Matkhau-123',
            displayName: 'Tác giả',
        });
    expect(auth.status).toBe(201);
    const owner = auth.body.data.user.id as string,
        token = auth.body.data.accessToken as string,
        bookId = randomUUID();
    await pool.query("INSERT INTO books(id,owner_id,title) VALUES ($1,$2,'Bản nháp WK06')", [
        bookId,
        owner,
    ]);
    const pages: string[] = [],
        assets: string[] = [];
    for (let i = 0; i < count; i++) {
        const asset = randomUUID(),
            page = randomUUID();
        await pool.query(
            `INSERT INTO assets(id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
            VALUES ($1,$2,'IMAGE','page',$3,'image','png',1000,'READY')`,
            [asset, owner, `bookaria/${owner}/${asset}`],
        );
        await pool.query(
            `INSERT INTO pages(id,book_id,order_index,image_asset_id,marker_mode,marker_mind_public_id,marker_score)
            VALUES ($1,$2,$3,$4,'CUSTOM_MARKER',$5,NULL)`,
            [page, bookId, i, asset, `bookaria/${owner}/${page}.mind`],
        );
        pages.push(page);
        assets.push(asset);
    }
    return { owner, token, bookId, pages, assets };
}
const jobState = async (id: string) =>
    (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
const links = async (bookId: string) =>
    (await pool.query('SELECT * FROM preview_links WHERE book_id=$1 ORDER BY created_at', [bookId]))
        .rows;
const bookState = async (bookId: string) =>
    (await pool.query('SELECT * FROM books WHERE id=$1', [bookId])).rows[0];
const enqueue = async (s: Awaited<ReturnType<typeof setup>>) =>
    (await createPreview(s.owner, s.bookId, { scope: 'BOOK' })).jobId;
function pipeline(hook?: () => Promise<void>) {
    const uploads = new Map<string, Buffer>();
    const storage: PublishStorage = {
        url,
        downloadMind: vi.fn(async () => real),
        upload: vi.fn(async (id, bytes) => {
            uploads.set(id, bytes);
            await hook?.();
            return url({ resourceType: 'raw', publicId: id });
        }),
    };
    const handler = createBuildPreviewHandler(
        storage,
        'https://viewer.example.com',
        'https://api.example.com',
    );
    const readFile = vi.fn(async (file: { publicId: string }) => {
        const bytes = uploads.get(file.publicId);
        if (!bytes) throw new Error('missing fixture');
        return bytes;
    });
    const reader = createPreviewReader(readFile);
    const publicApp = express();
    publicApp.use('/api/v1/public/previews', publicPreviewRouter(false, reader));
    publicApp.use(errorMiddleware);
    return { storage, uploads, handler, reader, readFile, publicApp };
}
async function built(count = 1) {
    const s = await setup(count),
        p = pipeline(),
        job = await enqueue(s);
    expect(await runJob(job, p.handler)).toBe('done');
    return { s, p, job, result: (await jobState(job)).result as { token: string; url: string } };
}
suite('BUILD_PREVIEW and expiring public API', () => {
    it('registers all four handlers', () => {
        for (const name of [
            'OPTIMIZE_ASSET',
            'SCORE_MARKER',
            'PUBLISH_BOOK',
            'BUILD_PREVIEW',
        ] as const)
            expect(typeof handlers[name]).toBe('function');
    });
    it('returns 202, serializes concurrent creation, protects job ownership and disables job caching', async () => {
        const s = await setup(),
            other = await setup();
        expect(
            (await request(app).post(`/api/v1/books/${s.bookId}/previews`).send({ scope: 'BOOK' }))
                .status,
        ).toBe(401);
        expect(
            (
                await request(app)
                    .post(`/api/v1/books/${s.bookId}/previews`)
                    .auth(other.token, { type: 'bearer' })
                    .send({ scope: 'BOOK' })
            ).status,
        ).toBe(404);
        const replies = await Promise.all(
            [0, 1].map(() =>
                request(app)
                    .post(`/api/v1/books/${s.bookId}/previews`)
                    .auth(s.token, { type: 'bearer' })
                    .send({ scope: 'BOOK' }),
            ),
        );
        expect(replies.map((r) => r.status).sort()).toEqual([202, 409]);
        const id = replies.find((r) => r.status === 202)?.body.data.jobId;
        expect(replies.find((r) => r.status === 409)?.body.error.details.jobId).toBe(id);
        const own = await request(app).get(`/api/v1/jobs/${id}`).auth(s.token, { type: 'bearer' });
        expect(own.status).toBe(200);
        expect(own.headers['cache-control']).toContain('no-store');
        expect(
            (await request(app).get(`/api/v1/jobs/${id}`).auth(other.token, { type: 'bearer' }))
                .status,
        ).toBe(404);
    });
    it('starts 24 hours at commit, accepts unverified/unscored draft and does not publish', async () => {
        const s = await setup(),
            before = await bookState(s.bookId),
            p = pipeline(),
            job = await enqueue(s);
        await pool.query("UPDATE jobs SET created_at=now()-interval '2 days' WHERE id=$1", [job]);
        expect(await runJob(job, p.handler)).toBe('done');
        const row = (await links(s.bookId))[0],
            result = (await jobState(job)).result;
        expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(result.url).toBe(`https://viewer.example.com/preview/${result.token}`);
        expect(row.token).toBe(result.token);
        const ttl = Number(
            (
                await pool.query(
                    'SELECT extract(epoch FROM expires_at-clock_timestamp()) AS seconds FROM preview_links WHERE id=$1',
                    [row.id],
                )
            ).rows[0].seconds,
        );
        expect(ttl).toBeGreaterThan(86390);
        expect(ttl).toBeLessThanOrEqual(86400);
        expect(await bookState(s.bookId)).toEqual(before);
        expect(
            (await pool.query('SELECT id FROM book_versions WHERE book_id=$1', [s.bookId]))
                .rowCount,
        ).toBe(0);
        const manifest = ManifestSchema.parse(row.manifest);
        expect(manifest.version).toBe(1);
        expect(manifest.targetGroups[0]?.mindUrl).toBe(
            `https://api.example.com/api/v1/public/previews/${result.token}/groups/0`,
        );
        expect(JSON.stringify(manifest)).not.toContain('bookaria/previews/');
        expect([...p.uploads.keys()]).toHaveLength(1); // Only .mind; no public JSON or token-bearing QR uploaded.
    });
    it('splits 12 AR pages into groups of 10 and 2, keeps NONE pages outside groups', async () => {
        const s = await setup(13),
            p = pipeline();
        await pool.query(
            "UPDATE pages SET marker_mode='NONE',marker_mind_public_id=NULL WHERE id=$1",
            [s.pages[12]],
        );
        expect(await runJob(await enqueue(s), p.handler)).toBe('done');
        const manifest = ManifestSchema.parse((await links(s.bookId))[0].manifest);
        expect(manifest.pages).toHaveLength(13);
        expect(manifest.targetGroups.map((g) => g.pageIds.length)).toEqual([10, 2]);
        const decoded = [...p.uploads.values()].map(
            (b) => decode(b) as { v: number; dataList: unknown[] },
        );
        expect(decoded.map((g) => g.dataList.length)).toEqual([10, 2]);
        expect(manifest.targetGroups.flatMap((g) => g.pageIds)).not.toContain(s.pages[12]);
    });
    it('PAGE includes only the selected page and assets; an unrelated page asset does not block it', async () => {
        const s = await setup(2),
            p = pipeline();
        await pool.query("UPDATE assets SET status='PROCESSING' WHERE id=$1", [s.assets[1]]);
        const job = (
            await createPreview(s.owner, s.bookId, { scope: 'PAGE', pageId: s.pages[0] as string })
        ).jobId;
        expect(await runJob(job, p.handler)).toBe('done');
        const manifest = ManifestSchema.parse((await links(s.bookId))[0].manifest);
        expect(manifest.pages.map((page) => page.pageId)).toEqual([s.pages[0]]);
        expect(manifest.pages[0]?.imageUrl).toContain(s.assets[0]);
        expect(JSON.stringify(manifest)).not.toContain(s.assets[1]);
        await expect(createPreview(s.owner, s.bookId, { scope: 'BOOK' })).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
        });
        await expect(
            createPreview(s.owner, s.bookId, { scope: 'PAGE', pageId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    it('allows an all-NONE preview with no marker download or upload', async () => {
        const s = await setup(),
            p = pipeline();
        await pool.query(
            "UPDATE pages SET marker_mode='NONE',marker_mind_public_id=NULL WHERE book_id=$1",
            [s.bookId],
        );
        expect(await runJob(await enqueue(s), p.handler)).toBe('done');
        expect((await links(s.bookId))[0].manifest.targetGroups).toEqual([]);
        expect(p.storage.downloadMind).not.toHaveBeenCalled();
        expect(p.storage.upload).not.toHaveBeenCalled();
    });
    it('rejects an empty book and an invalid PAGE body at the author API', async () => {
        const s = await setup(0);
        for (const body of [{ scope: 'BOOK' }, { scope: 'PAGE' }]) {
            expect(
                (
                    await request(app)
                        .post(`/api/v1/books/${s.bookId}/previews`)
                        .auth(s.token, { type: 'bearer' })
                        .send(body)
                ).status,
            ).toBe(400);
        }
    });
    it.each(['before', 'during'] as const)(
        'rejects a draft edited %s the build without exposing a partial link',
        async (timing) => {
            const s = await setup(),
                job = await enqueue(s);
            const change = async () => {
                await pool.query("UPDATE books SET title='Changed' WHERE id=$1", [s.bookId]);
            };
            if (timing === 'before') await change();
            const p = pipeline(timing === 'during' ? change : undefined);
            expect(await runJob(job, p.handler)).toBe('failed');
            expect((await jobState(job)).error.code).toBe('PREVIEW_STALE');
            expect(await links(s.bookId)).toHaveLength(0);
        },
    );
    it('rolls back the inserted preview if the success transaction is interrupted', async () => {
        const s = await setup(),
            p = pipeline(),
            job = await enqueue(s);
        const handler: JobHandler = (ctx) =>
            p.handler({
                ...ctx,
                onSuccess: (commit) =>
                    ctx.onSuccess(async (db) => {
                        await commit(db);
                        throw new JobError('TEST_ROLLBACK', 'Rollback fixture');
                    }),
            });
        expect(await runJob(job, handler)).toBe('failed');
        expect(await links(s.bookId)).toHaveLength(0);
    });
    it('skips an older attempt and makes successful delivery idempotent', async () => {
        const s = await setup(),
            job = await enqueue(s);
        let nested = false;
        const p = pipeline(async () => {
            if (nested) return;
            nested = true;
            expect(await runJob(job, pipeline().handler)).toBe('done');
        });
        expect(await runJob(job, p.handler)).toBe('skipped');
        expect(await runJob(job, p.handler)).toBe('skipped');
        expect(await links(s.bookId)).toHaveLength(1);
    });
    it('retries a transient storage failure and commits one link on the next attempt', async () => {
        const s = await setup(),
            p = pipeline(),
            job = await enqueue(s);
        p.storage.upload = vi.fn(async () => {
            throw new JobError('STORAGE_TEMPORARY', 'Retry fixture', true);
        });
        await expect(runJob(job, p.handler)).rejects.toMatchObject({ code: 'STORAGE_TEMPORARY' });
        expect(await links(s.bookId)).toHaveLength(0);
        expect((await jobState(job)).status).toBe('QUEUED');
        expect(await runJob(job, pipeline().handler)).toBe('done');
        expect(await links(s.bookId)).toHaveLength(1);
    });
    it('serves frozen JSON and binary without auth, with expiry and no-store headers', async () => {
        const { s, p, result } = await built(),
            path = `/api/v1/public/previews/${result.token}`;
        await pool.query("UPDATE books SET title='New draft' WHERE id=$1", [s.bookId]);
        const response = await request(app).get(path);
        expect(response.status).toBe(200);
        expect(response.body.data.title).toBe('Bản nháp WK06');
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(Date.parse(String(response.headers.expires))).toBeGreaterThan(Date.now());
        const group = await request(p.publicApp).get(`${path}/groups/0`);
        expect(group.status).toBe(200);
        expect(group.headers['content-type']).toContain('application/octet-stream');
        expect(group.body).toEqual([...p.uploads.values()][0]);
        expect(group.headers['cache-control']).toContain('no-store');
        const invalid = await request(p.publicApp).get(`${path}/groups/01`);
        expect(invalid.status).toBe(404);
    });
    it('returns 404 at/after expiry for both resources, including conditional GET', async () => {
        const { s, p, result } = await built(),
            path = `/api/v1/public/previews/${result.token}`;
        const fresh = await request(app).get(path);
        await pool.query('UPDATE preview_links SET expires_at=clock_timestamp() WHERE book_id=$1', [
            s.bookId,
        ]);
        for (const route of [path, `${path}/groups/0`]) {
            const response = await request(p.publicApp)
                .get(route)
                .set('If-None-Match', fresh.headers.etag ?? '*');
            expect(response.status).toBe(404);
            expect(response.headers['cache-control']).toContain('no-store');
        }
        expect(p.readFile).not.toHaveBeenCalled();
    });
    it('rechecks expiry after a slow group download', async () => {
        const { s, p, result } = await built();
        const reader = createPreviewReader(async (file) => {
            await pool.query(
                'UPDATE preview_links SET expires_at=clock_timestamp() WHERE book_id=$1',
                [s.bookId],
            );
            return p.readFile(file);
        });
        await expect(
            reader.group(result.token, 0, new AbortController().signal),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    it.each(['deleted', 'taken-down', 'locked'] as const)(
        'blocks existing links when the source is %s',
        async (reason) => {
            const { s, p, result } = await built();
            if (reason === 'locked')
                await pool.query("UPDATE users SET status='LOCKED' WHERE id=$1", [s.owner]);
            else
                await pool.query(
                    reason === 'deleted'
                        ? 'UPDATE books SET deleted_at=now() WHERE id=$1'
                        : "UPDATE books SET taken_down_at=now(),taken_down_reason='Test fixture' WHERE id=$1",
                    [s.bookId],
                );
            await expect(p.reader.manifest(result.token)).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
            await expect(
                p.reader.group(result.token, 0, new AbortController().signal),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(p.readFile).not.toHaveBeenCalled();
        },
    );
    it('uses a new token for a later preview without revoking the earlier frozen snapshot', async () => {
        const { s, p, result } = await built();
        await pool.query("UPDATE books SET title='Second' WHERE id=$1", [s.bookId]);
        const job = await enqueue(s);
        expect(await runJob(job, p.handler)).toBe('done');
        const next = (await jobState(job)).result;
        expect(next.token).not.toBe(result.token);
        expect((await p.reader.manifest(result.token)).manifest.title).toBe('Bản nháp WK06');
        expect((await p.reader.manifest(next.token)).manifest.title).toBe('Second');
    });
    it('hides invalid tokens and absent groups without fetching storage', async () => {
        const { p, result } = await built();
        for (const token of ['bad', 'x'.repeat(32)])
            await expect(p.reader.manifest(token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
            p.reader.group(result.token, 99, new AbortController().signal),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(p.readFile).not.toHaveBeenCalled();
    });
    it('treats nullable legacy mind_groups as an empty list', async () => {
        const { s, p, result } = await built();
        await pool.query('UPDATE preview_links SET mind_groups=NULL WHERE book_id=$1', [s.bookId]);
        await expect(
            p.reader.group(result.token, 0, new AbortController().signal),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(p.readFile).not.toHaveBeenCalled();
    });
    it('builds a validated Bookaria marker and rejects it if disabled during upload', async () => {
        const s = await setup(),
            id = randomUUID();
        await pool.query(
            `INSERT INTO bookaria_markers(id,number,seed,image_public_id,mind_public_id,validated_at)
            VALUES ($1,$2,$3,'image','bookaria/markers/valid.mind',now())`,
            [
                id,
                Number.parseInt(id.slice(0, 7), 16) + 1,
                BigInt(`0x${id.replaceAll('-', '').slice(0, 12)}`).toString(),
            ],
        );
        await pool.query(
            `UPDATE pages SET marker_mode='BOOKARIA_MARKER',marker_mind_public_id=NULL,bookaria_marker_id=$2,
            bookaria_marker_transform='{"x":0,"y":0,"size":0.2}' WHERE id=$1`,
            [s.pages[0], id],
        );
        const p = pipeline();
        expect(await runJob(await enqueue(s), p.handler)).toBe('done');
        expect(p.storage.downloadMind).toHaveBeenCalledWith(
            'bookaria/markers/valid.mind',
            expect.any(AbortSignal),
        );
        const next = await enqueue(s),
            changed = pipeline(async () => {
                await pool.query('UPDATE bookaria_markers SET is_active=false WHERE id=$1', [id]);
            });
        expect(await runJob(next, changed.handler)).toBe('failed');
        expect(await links(s.bookId)).toHaveLength(1);
    });
    it('rejects malformed .mind before committing any link', async () => {
        const s = await setup(),
            p = pipeline(),
            job = await enqueue(s);
        p.storage.downloadMind = async () => Buffer.from('invalid');
        expect(await runJob(job, p.handler)).toBe('failed');
        expect((await jobState(job)).error.code).toBe('INVALID_MIND');
        expect(await links(s.bookId)).toHaveLength(0);
    });
    it('runs the tutorial CLI against the real API and generates local PNG/SVG QR files', async () => {
        const s = await setup(),
            p = pipeline(),
            root = await mkdtemp(join(tmpdir(), 'bookaria-wk06-test-'));
        const output = join(root, 'preview');
        const server = app.listen(0, '127.0.0.1');
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('no TCP address');
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', 'src/scripts/try-preview.ts', s.bookId, output],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    BOOKARIA_API: `http://127.0.0.1:${address.port}/api/v1`,
                    BOOKARIA_TOKEN: s.token,
                },
                windowsHide: true,
            },
        );
        let log = '';
        child.stdout?.on('data', (chunk) => {
            log += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
            log += String(chunk);
        });
        const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
        try {
            let id: string | undefined;
            const deadline = Date.now() + 8000;
            while (!id && Date.now() < deadline) {
                id = (
                    await pool.query(
                        "SELECT id FROM jobs WHERE type='BUILD_PREVIEW' AND ref_id=$1",
                        [s.bookId],
                    )
                ).rows[0]?.id;
                if (!id) await sleep(50);
            }
            expect(id, log).toBeDefined();
            expect(await runJob(id as string, p.handler)).toBe('done');
            const exit = await Promise.race([exited, sleep(8000).then(() => -99)]);
            expect(exit, log).toBe(0);
            const report = JSON.parse(await readFile(join(output, 'preview.json'), 'utf8'));
            expect(report.token).toBe((await jobState(id as string)).result.token);
            expect(report.pages).toBe(1);
            expect(report.groups).toBe(1);
            expect((await readFile(join(output, 'qr.png'))).subarray(0, 8).toString('hex')).toBe(
                '89504e470d0a1a0a',
            );
            expect(await readFile(join(output, 'qr.svg'), 'utf8')).toContain('<svg');
        } finally {
            if (child.exitCode === null) child.kill();
            await exited;
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
            const below = relative(resolve(tmpdir()), resolve(root));
            if (
                !isAbsolute(below) &&
                !below.startsWith('..') &&
                below.startsWith('bookaria-wk06-test-')
            )
                await rm(root, { recursive: true, force: true });
        }
    });
});
