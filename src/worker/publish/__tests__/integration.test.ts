import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '@msgpack/msgpack';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { type MediaStorage, setMediaStorage } from '../../../lib';
import { JobError, type JobHandler } from '../../../modules/jobs/jobs.types';
import { publishService } from '../../../modules/publish/publish.service';
import { ManifestSchema } from '../../../schema';
import { handlers } from '../../handlers';
import { runJob } from '../../runner';
import { createPublishHandler } from '..';
import { decodeSingleMind } from '../mind';
import type { PublishStorage } from '../storage';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const real = readFileSync(new URL('./fixtures/card.mind', import.meta.url));
const url: PublishStorage['url'] = ({ publicId }) => `https://example.com/${publicId}`;
const media: MediaStorage = {
    deliveryUrl: url,
    inspect: async () => null,
    destroy: async () => {},
    signUpload: () => {
        throw new Error('unused');
    },
};
async function setup(count = 1) {
    const auth = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `publish-worker-${randomUUID()}@example.com`,
            password: 'Matkhau-123',
            displayName: 'Tác giả',
        });
    expect(auth.status).toBe(201);
    const owner = auth.body.data.user.id as string,
        token = auth.body.data.accessToken as string,
        bookId = randomUUID();
    await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [owner]);
    await pool.query("INSERT INTO books (id,owner_id,title) VALUES ($1,$2,'WK05')", [
        bookId,
        owner,
    ]);
    const pages: string[] = [],
        assets: string[] = [];
    for (let i = 0; i < count; i++) {
        const id = randomUUID(),
            page = randomUUID();
        await pool.query(
            `INSERT INTO assets (id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
            VALUES ($1,$2,'IMAGE','page',$3,'image','png',1000,'READY')`,
            [id, owner, `bookaria/${owner}/${id}`],
        );
        await pool.query(
            `INSERT INTO pages (id,book_id,order_index,image_asset_id,marker_mode,marker_mind_public_id,marker_score)
            VALUES ($1,$2,$3,$4,'CUSTOM_MARKER',$5,4)`,
            [page, bookId, i, id, `bookaria/${owner}/${page}.mind`],
        );
        pages.push(page);
        assets.push(id);
    }
    return { owner, token, bookId, pages, assets };
}
async function enqueue(s: Awaited<ReturnType<typeof setup>>) {
    return (
        await publishService.publishBook(s.owner, s.bookId, {
            visibility: 'UNLISTED',
            acceptWarnings: true,
        })
    ).jobId;
}
const state = async (s: { bookId: string }) =>
    (await pool.query('SELECT * FROM books WHERE id=$1', [s.bookId])).rows[0];
const jobState = async (id: string) =>
    (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
const versions = async (s: { bookId: string }) =>
    (
        await pool.query('SELECT * FROM book_versions WHERE book_id=$1 ORDER BY version_no', [
            s.bookId,
        ])
    ).rows;
function pipeline(hook?: (id: string) => Promise<void>) {
    const uploads = new Map<string, Buffer>();
    const storage: PublishStorage = {
        url,
        downloadMind: vi.fn(async () => real),
        upload: vi.fn(async (id, bytes) => {
            uploads.set(id, bytes);
            await hook?.(id);
            return url({ resourceType: 'raw', publicId: id });
        }),
    };
    return {
        storage,
        uploads,
        handler: createPublishHandler(storage, 'https://viewer.example.com'),
    };
}
suite('PUBLISH_BOOK transaction and public API', () => {
    beforeAll(() => setMediaStorage(media));
    afterAll(() => setMediaStorage(undefined));
    it('keeps the three worker handlers registered', () => {
        for (const key of ['OPTIMIZE_ASSET', 'SCORE_MARKER', 'PUBLISH_BOOK'] as const)
            expect(typeof handlers[key]).toBe('function');
    });
    it('uses optimized assets, includes background audio and credits without double-counting assets', async () => {
        const s = await setup(2),
            model = randomUUID(),
            audio = randomUUID();
        await pool.query(
            `INSERT INTO assets (id,type,name,original_public_id,optimized_public_id,resource_type,format,size_bytes,status,meta,license,author_name)
            VALUES ($1,'MODEL','model','original','optimized','image','glb',10000,'READY','{"downloadBytes":200,"geometryCompression":"draco"}','CC-BY-4.0','Artist')`,
            [model],
        );
        await pool.query(
            `INSERT INTO assets (id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
            VALUES ($1,$2,'AUDIO','audio','sound.mp3','raw','mp3',300,'READY')`,
            [audio, s.owner],
        );
        await pool.query('UPDATE pages SET scene=$2::jsonb,settings=$3::jsonb WHERE book_id=$1', [
            s.bookId,
            JSON.stringify({
                schemaVersion: 1,
                objects: [{ id: 'model1', type: 'model', assetId: model, transform: {} }],
                interactions: [],
            }),
            JSON.stringify({ backgroundAudioAssetId: audio }),
        ]);
        for (const page of s.pages)
            for (const id of [model, audio])
                await pool.query('INSERT INTO page_assets(page_id,asset_id) VALUES ($1,$2)', [
                    page,
                    id,
                ]);
        const p = pipeline();
        expect(await runJob(await enqueue(s), p.handler)).toBe('done');
        const row = (await versions(s))[0],
            bytes = p.uploads.get(row.manifest_public_id) as Buffer;
        const referenced = await pool.query<{ asset_id: string }>(
            'SELECT asset_id FROM version_assets WHERE book_version_id=$1',
            [row.id],
        );
        expect(new Set(referenced.rows.map((item) => item.asset_id))).toEqual(
            new Set([...s.assets, model, audio]),
        );
        const manifest = ManifestSchema.parse(JSON.parse(bytes.toString()));
        expect(manifest.assets[model]).toMatchObject({
            url: 'https://example.com/optimized',
            size: 200,
        });
        expect(manifest.assets[audio]?.url).toBe('https://example.com/sound.mp3');
        expect(manifest.credits).toContainEqual({
            assetId: model,
            name: 'model',
            license: 'CC-BY-4.0',
            author: 'Artist',
        });
        const mindBytes = row.mind_groups.reduce(
            (sum: number, g: { public_id: string }) =>
                sum + (p.uploads.get(g.public_id)?.length ?? 0),
            0,
        );
        expect(Number(row.total_size_bytes)).toBe(2000 + 200 + 300 + mindBytes + bytes.length);
    });
    it('keeps an asset used only by an older published version', async () => {
        const s = await setup();
        expect(await runJob(await enqueue(s), pipeline().handler)).toBe('done');
        const versionId = (await versions(s))[0].id;
        const assetId = s.assets[0];
        const references = await pool.query(
            'SELECT asset_id FROM version_assets WHERE book_version_id=$1 AND asset_id=$2',
            [versionId, assetId],
        );
        expect(references.rowCount).toBe(1);
        const replacement = randomUUID();
        await pool.query(
            `INSERT INTO assets (id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
             VALUES ($1,$2,'IMAGE','replacement',$3,'image','png',1000,'READY')`,
            [replacement, s.owner, `bookaria/${s.owner}/${replacement}`],
        );
        await pool.query('UPDATE pages SET image_asset_id=$2 WHERE id=$1', [
            s.pages[0],
            replacement,
        ]);
        expect(await runJob(await enqueue(s), pipeline().handler)).toBe('done');
        const latestVersionId = (await versions(s))[1].id;
        expect(
            (
                await pool.query(
                    'SELECT 1 FROM version_assets WHERE book_version_id=$1 AND asset_id=$2',
                    [latestVersionId, assetId],
                )
            ).rowCount,
        ).toBe(0);
        const removedAsset = await request(app)
            .delete(`/api/v1/assets/${assetId}`)
            .auth(s.token, { type: 'bearer' });
        expect(removedAsset.status).toBe(409);
        expect(removedAsset.body.error.code).toBe('ASSET_IN_USE');
        expect(
            (await pool.query('SELECT deleted_at FROM assets WHERE id=$1', [assetId])).rows[0]
                .deleted_at,
        ).toBeNull();
    });
    it('loads a validated Bookaria marker and rejects disabling it during upload', async () => {
        const s = await setup(),
            id = randomUUID(),
            number = Number.parseInt(id.slice(0, 7), 16) + 1;
        await pool.query(
            `INSERT INTO bookaria_markers(id,number,seed,image_public_id,mind_public_id,validated_at)
            VALUES ($1,$2,$3,'marker-image','bookaria/markers/valid.mind',now())`,
            [id, number, BigInt(`0x${id.replaceAll('-', '').slice(0, 12)}`).toString()],
        );
        await pool.query(
            `UPDATE pages SET marker_mode='BOOKARIA_MARKER',marker_mind_public_id=NULL,bookaria_marker_id=$2,
            bookaria_marker_transform='{"x":0,"y":0,"size":0.2}' WHERE id=$1`,
            [s.pages[0], id],
        );
        const p = pipeline(),
            job = await enqueue(s);
        expect(await runJob(job, p.handler)).toBe('done');
        expect(p.storage.downloadMind).toHaveBeenCalledWith(
            'bookaria/markers/valid.mind',
            expect.any(AbortSignal),
        );
        const next = await enqueue(s);
        expect(
            await runJob(
                next,
                pipeline(async () => {
                    await pool.query('UPDATE bookaria_markers SET is_active=false WHERE id=$1', [
                        id,
                    ]);
                }).handler,
            ),
        ).toBe('failed');
        expect(await versions(s)).toHaveLength(1);
    });
    it('splits a group earlier than ten pages when the encoded group would exceed 9 MB', async () => {
        const s = await setup(2),
            p = pipeline();
        const target = decodeSingleMind(real);
        const large = Buffer.from(
            encode({
                v: 2,
                dataList: [{ ...target, matchingData: [{ padding: new Uint8Array(4_700_000) }] }],
            }),
        );
        p.storage.downloadMind = async () => large;
        expect(
            await runJob(
                await enqueue(s),
                createPublishHandler(p.storage, 'https://viewer.example.com'),
            ),
        ).toBe('done');
        expect(
            (await versions(s))[0].mind_groups.map(
                (g: { page_ids: string[] }) => g.page_ids.length,
            ),
        ).toEqual([1, 1]);
    });
    it('does not let an older attempt supersede the successful newer attempt', async () => {
        const s = await setup(),
            job = await enqueue(s);
        let nested = false;
        const p = pipeline(async () => {
            if (nested) return;
            nested = true;
            expect(await runJob(job, pipeline().handler)).toBe('done');
        });
        expect(await runJob(job, p.handler)).toBe('skipped');
        expect(await versions(s)).toHaveLength(1);
        expect((await jobState(job)).attempts).toBe(2);
    });
    it('fails malformed marker data before any publication can be committed', async () => {
        const s = await setup(),
            p = pipeline();
        p.storage.downloadMind = async () => Buffer.from('not a mind');
        const job = await enqueue(s);
        expect(
            await runJob(job, createPublishHandler(p.storage, 'https://viewer.example.com')),
        ).toBe('failed');
        expect((await jobState(job)).error.code).toBe('INVALID_MIND');
        expect(await versions(s)).toHaveLength(0);
        expect(p.uploads.size).toBe(0);
    });
    it('publishes 12 AR pages in groups 10+2, skips NONE targets, exposes immutable manifest and QR', async () => {
        const s = await setup(13);
        await pool.query(
            "UPDATE pages SET marker_mode='NONE',marker_mind_public_id=NULL WHERE id=$1",
            [s.pages[1]],
        );
        const job = await enqueue(s),
            p = pipeline();
        expect(await runJob(job, p.handler)).toBe('done');
        const book = await state(s),
            rows = await versions(s),
            version = rows[0];
        expect(book).toMatchObject({
            status: 'PUBLISHED',
            visibility: 'UNLISTED',
            current_version_id: version.id,
        });
        expect(rows).toHaveLength(1);
        expect(version).toMatchObject({ version_no: 1, page_count: 13, ar_page_count: 12 });
        const raw = p.uploads.get(version.manifest_public_id) as Buffer;
        const manifest = ManifestSchema.parse(JSON.parse(raw.toString()));
        const ar = s.pages.filter((id) => id !== s.pages[1]);
        expect(manifest.targetGroups.map((g) => g.pageIds)).toEqual([
            ar.slice(0, 10),
            ar.slice(10),
        ]);
        expect(manifest.pages[1]?.group).toBeUndefined();
        expect(manifest.pages[12]?.targetIndex).toBe(1);
        const group = p.uploads.get(version.mind_groups[0].public_id) as Buffer;
        expect((decode(group) as { dataList: unknown[] }).dataList).toHaveLength(10);
        expect((await jobState(job)).result.url).toBe(`https://viewer.example.com/b/${book.slug}`);
        const info = await request(app).get(`/api/v1/public/books/${book.slug}`);
        expect(info.status).toBe(200);
        expect(info.body.data.manifestUrl).toContain(version.manifest_public_id);
        const share = await request(app)
            .get(`/api/v1/books/${s.bookId}/share`)
            .auth(s.token, { type: 'bearer' });
        expect(share.status, JSON.stringify(share.body)).toBe(200);
        expect(share.body.data.qrPngUrl).toContain('/qr.png');
        const png = [...p.uploads].find(([id]) => id.endsWith('/qr.png'))?.[1];
        expect(png?.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(await runJob(job, p.handler)).toBe('skipped');
        expect(await versions(s)).toHaveLength(1);
    });
    it('republishes with the same slug and keeps the old version unchanged', async () => {
        const s = await setup(),
            p = pipeline();
        await runJob(await enqueue(s), p.handler);
        const old = (await versions(s))[0],
            slug = (await state(s)).slug;
        await pool.query("UPDATE books SET title='Second' WHERE id=$1", [s.bookId]);
        await runJob(await enqueue(s), p.handler);
        const rows = await versions(s);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual(old);
        expect(rows[1].version_no).toBe(2);
        expect((await state(s)).slug).toBe(slug);
        expect(rows[1].manifest_public_id).not.toBe(old.manifest_public_id);
    });
    it.each(['before', 'during'] as const)(
        'rejects edits %s processing and retains the old version',
        async (when) => {
            const s = await setup();
            await runJob(await enqueue(s), pipeline().handler);
            const old = (await state(s)).current_version_id;
            const job = await enqueue(s);
            let changed = false;
            const mutate = async () => {
                if (changed) return;
                changed = true;
                await pool.query("UPDATE pages SET title='edited' WHERE id=$1", [s.pages[0]]);
            };
            if (when === 'before') await mutate();
            expect(
                await runJob(job, pipeline(when === 'during' ? mutate : undefined).handler),
            ).toBe('failed');
            expect((await jobState(job)).error.code).toBe('PUBLISH_STALE');
            expect((await state(s)).current_version_id).toBe(old);
            expect(await versions(s)).toHaveLength(1);
        },
    );
    it('ignores view count changes while producing artifacts', async () => {
        const s = await setup();
        const job = await enqueue(s);
        expect(
            await runJob(
                job,
                pipeline(async () => {
                    await pool.query('UPDATE books SET view_count=view_count+1 WHERE id=$1', [
                        s.bookId,
                    ]);
                }).handler,
            ),
        ).toBe('done');
    });
    it.each(['asset', 'account', 'deleted', 'marker'] as const)(
        'refuses changed %s before commit',
        async (kind) => {
            const s = await setup(),
                job = await enqueue(s);
            let changed = false;
            const p = pipeline(async () => {
                if (changed) return;
                changed = true;
                if (kind === 'asset')
                    await pool.query("UPDATE assets SET status='FAILED' WHERE id=$1", [
                        s.assets[0],
                    ]);
                if (kind === 'account')
                    await pool.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [
                        s.owner,
                    ]);
                if (kind === 'deleted')
                    await pool.query('UPDATE books SET deleted_at=now() WHERE id=$1', [s.bookId]);
                if (kind === 'marker')
                    await pool.query('UPDATE pages SET marker_score=1 WHERE id=$1', [s.pages[0]]);
            });
            expect(await runJob(job, p.handler)).toBe('failed');
            expect(await versions(s)).toHaveLength(0);
        },
    );
    it('does not commit if uploading QR fails, and retries into a different attempt folder', async () => {
        const s = await setup();
        await runJob(await enqueue(s), pipeline().handler);
        const old = (await state(s)).current_version_id;
        const job = await enqueue(s),
            p = pipeline(async (id) => {
                if (id.endsWith('/qr.svg')) throw new JobError('TEMP', 'test', true);
            });
        await expect(runJob(job, p.handler)).rejects.toThrow('test');
        expect((await state(s)).current_version_id).toBe(old);
        expect(await versions(s)).toHaveLength(1);
        const retry = pipeline();
        expect(await runJob(job, retry.handler)).toBe('done');
        expect([...retry.uploads.keys()].every((id) => id.includes(`${job}-2/`))).toBe(true);
    });
    it('rolls back a callback that fails after inserting the version', async () => {
        const s = await setup(),
            job = await enqueue(s),
            p = pipeline();
        const wrapped: JobHandler = (ctx) =>
            p.handler({
                ...ctx,
                onSuccess: (cb) =>
                    ctx.onSuccess(async (db) => {
                        await cb(db);
                        throw new JobError('ROLLBACK', 'test');
                    }),
            });
        expect(await runJob(job, wrapped)).toBe('failed');
        expect(await versions(s)).toHaveLength(0);
        expect((await state(s)).current_version_id).toBeNull();
    });
    it('cancels before commit without publishing', async () => {
        const s = await setup(),
            job = await enqueue(s),
            abort = new AbortController();
        await expect(
            runJob(job, pipeline(async () => abort.abort()).handler, abort.signal),
        ).rejects.toThrow();
        expect(await versions(s)).toHaveLength(0);
    });
    it('rejects an old job missing snapshot metadata', async () => {
        const s = await setup(),
            job = await enqueue(s);
        await pool.query("UPDATE jobs SET payload='{}' WHERE id=$1", [job]);
        expect(await runJob(job, pipeline().handler)).toBe('failed');
        expect((await jobState(job)).error.code).toBe('PUBLISH_REQUEST_EXPIRED');
    });
    it('denies share information to another author', async () => {
        const s = await setup(),
            other = await setup();
        await runJob(await enqueue(s), pipeline().handler);
        expect(
            (
                await request(app)
                    .get(`/api/v1/books/${s.bookId}/share`)
                    .auth(other.token, { type: 'bearer' })
            ).status,
        ).toBe(404);
    });
    it('survives a forcibly killed worker before commit and completes on the next attempt', async () => {
        const s = await setup();
        await runJob(await enqueue(s), pipeline().handler);
        const old = (await state(s)).current_version_id;
        const job = await enqueue(s);
        await new Promise<void>((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    fileURLToPath(new URL('./crash-worker.ts', import.meta.url)),
                    job,
                ],
                { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let output = '',
                reached = false;
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`Crash test timeout: ${output}`));
            }, 12000);
            child.stdout.on('data', (chunk) => {
                output += chunk.toString();
                if (output.includes('UPLOAD_BEFORE_COMMIT')) {
                    reached = true;
                    child.kill('SIGKILL');
                }
            });
            child.stderr.on('data', (chunk) => {
                output += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', () => {
                clearTimeout(timeout);
                reached ? resolve() : reject(new Error(output));
            });
        });
        expect((await jobState(job)).status).toBe('RUNNING');
        expect((await state(s)).current_version_id).toBe(old);
        expect(await versions(s)).toHaveLength(1);
        expect(await runJob(job, pipeline().handler)).toBe('done');
        expect(await versions(s)).toHaveLength(2);
    });
});
