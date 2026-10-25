import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { JobError, type JobHandler } from '../../../modules/jobs/jobs.types';
import { PrintSourceSchema } from '../../../modules/print/print.source';
import { publishService } from '../../../modules/publish/publish.service';
import { defaultMarkerTransform, type PrintPdfBody } from '../../../schema';
import { handlers } from '../../handlers';
import { createPublishHandler } from '../../publish';
import type { PublishStorage } from '../../publish/storage';
import { runJob } from '../../runner';
import { createExportPdfHandler } from '..';
import type { PrintStorage } from '../storage';
import { readFont, sampleImages, sampleSource } from './fixtures';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false }),
    real = readFileSync(new URL('../../publish/__tests__/fixtures/card.mind', import.meta.url));
const url: PublishStorage['url'] = ({ publicId }) => `https://cdn.example.com/${publicId}`;
async function setup(publish = true) {
    const auth = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `pdf-${randomUUID()}@example.com`,
            password: 'Matkhau-123',
            displayName: 'Tác giả',
        });
    expect(auth.status).toBe(201);
    const owner = auth.body.data.user.id as string,
        token = auth.body.data.accessToken as string,
        bookId = randomUUID(),
        marker = randomUUID(),
        source = sampleSource();
    await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [owner]);
    await pool.query('INSERT INTO books(id,owner_id,title) VALUES ($1,$2,$3)', [
        bookId,
        owner,
        source.title,
    ]);
    await pool.query(
        `INSERT INTO bookaria_markers(id,number,seed,image_public_id,mind_public_id,validated_at)
        VALUES ($1,$2,$3,'fixture/marker','fixture/mind',now())`,
        [
            marker,
            Number.parseInt(marker.slice(0, 7), 16) + 1,
            BigInt(`0x${marker.replaceAll('-', '').slice(0, 12)}`).toString(),
        ],
    );
    for (const [index, p] of source.pages.entries()) {
        const asset = randomUUID();
        await pool.query(
            `INSERT INTO assets(id,owner_id,type,name,original_public_id,resource_type,format,size_bytes,status)
            VALUES ($1,$2,'IMAGE','page',$3,'image','png',1000,'READY')`,
            [asset, owner, `bookaria/${owner}/page-${index}`],
        );
        await pool.query(
            `INSERT INTO pages(id,book_id,order_index,image_asset_id,marker_mode,bookaria_marker_id,bookaria_marker_transform)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [
                p.pageId,
                bookId,
                index,
                asset,
                p.marker.mode,
                p.marker.mode === 'BOOKARIA_MARKER' ? marker : null,
                p.marker.mode === 'BOOKARIA_MARKER' ? JSON.stringify(p.marker.transform) : null,
            ],
        );
    }
    const publishJob = async () => {
        const job = (
            await publishService.publishBook(owner, bookId, {
                visibility: 'UNLISTED',
                acceptWarnings: true,
            })
        ).jobId;
        const storage: PublishStorage = {
            url,
            downloadMind: async () => real,
            upload: async (id) => url({ resourceType: 'raw', publicId: id }),
        };
        const outcome = await runJob(
            job,
            createPublishHandler(storage, 'https://viewer.example.com'),
        );
        expect(
            outcome,
            JSON.stringify((await pool.query('SELECT error FROM jobs WHERE id=$1', [job])).rows[0]),
        ).toBe('done');
    };
    if (publish) await publishJob();
    return { owner, token, bookId, source, publishJob };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const versions = async (s: Setup) =>
    (
        await pool.query('SELECT * FROM book_versions WHERE book_id=$1 ORDER BY version_no', [
            s.bookId,
        ])
    ).rows;
const jobState = async (id: string) =>
    (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
async function enqueue(s: Setup, body: Partial<PrintPdfBody> = {}) {
    const response = await request(app)
        .post(`/api/v1/books/${s.bookId}/print-pdf`)
        .auth(s.token, { type: 'bearer' })
        .send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return response.body.data.jobId as string;
}
async function pipeline(hook?: () => Promise<void>) {
    const uploads = new Map<string, Buffer>();
    const storage: PrintStorage = {
        url,
        download: await sampleImages(),
        upload: async (id, bytes) => {
            uploads.set(id, bytes);
            await hook?.();
            return url({ resourceType: 'raw', publicId: id });
        },
    };
    return {
        storage,
        uploads,
        handler: createExportPdfHandler(storage, 'https://viewer.example.com', await readFont()),
    };
}
suite('EXPORT_PDF publication consistency', () => {
    it('preserves the custom dimensions entered through the API in published and printed pages', async () => {
        const s = await setup(false);
        const changed = await request(app)
            .patch(`/api/v1/books/${s.bookId}`)
            .auth(s.token, { type: 'bearer' })
            .send({ pageFormat: 'CUSTOM', pageWidthMm: 180, pageAspect: 1.5 });
        expect(changed.status).toBe(200);
        // Existing marker placement must be updated for the new physical page size.
        const marker = await request(app)
            .put(`/api/v1/pages/${s.source.pages[0]?.pageId}/marker`)
            .auth(s.token, { type: 'bearer' })
            .send({
                mode: 'BOOKARIA_MARKER',
                transform: defaultMarkerTransform(
                    { format: 'CUSTOM', aspect: 1.5, widthMm: 180 },
                    0,
                ),
            });
        expect(marker.status, JSON.stringify(marker.body)).toBe(200);
        await s.publishJob();
        const source = PrintSourceSchema.parse((await versions(s))[0].print_source);
        expect(source.widthMm).toBe(180);
        expect(source.heightMm).toBe(270);
        const job = await enqueue(s),
            p = await pipeline();
        // Imported page images are rendered to the chosen 180 x 270 mm aspect.
        p.storage.download = await sampleImages(720, 1080);
        const outcome = await runJob(job, p.handler);
        expect(outcome, JSON.stringify((await jobState(job)).error)).toBe('done');
        const pdf = await PDFDocument.load([...p.uploads.values()][0] as Buffer);
        const trim = pdf.getPages()[2]?.getTrimBox();
        expect(trim?.width).toBeCloseTo((180 * 72) / 25.4, 5);
        expect(trim?.height).toBeCloseTo((270 * 72) / 25.4, 5);
    });
    it('registers all five handlers', () => {
        for (const key of [
            'OPTIMIZE_ASSET',
            'SCORE_MARKER',
            'PUBLISH_BOOK',
            'BUILD_PREVIEW',
            'EXPORT_PDF',
        ] as const)
            expect(typeof handlers[key]).toBe('function');
    });
    it('captures immutable print source in the publish transaction', async () => {
        const s = await setup(),
            v = (await versions(s))[0],
            source = PrintSourceSchema.parse(v.print_source);
        expect(source.widthMm).toBe(210);
        expect(source.pages).toHaveLength(2);
        expect(source.pages[0]?.marker.mode).toBe('BOOKARIA_MARKER');
        await expect(
            pool.query("UPDATE book_versions SET print_source='{}' WHERE id=$1", [v.id]),
        ).rejects.toMatchObject({ code: '23001' });
    });
    it('returns 202/409 for concurrent requests and checks author access', async () => {
        const s = await setup(),
            other = await setup(false),
            path = `/api/v1/books/${s.bookId}/print-pdf`;
        expect((await request(app).post(path).send({})).status).toBe(401);
        expect(
            (await request(app).post(path).auth(other.token, { type: 'bearer' }).send({})).status,
        ).toBe(404);
        const replies = await Promise.all(
            [0, 1].map(() => request(app).post(path).auth(s.token, { type: 'bearer' }).send({})),
        );
        expect(replies.map((r) => r.status).sort()).toEqual([202, 409]);
    });
    it('rejects an unpublished book and a legacy version without print source', async () => {
        const s = await setup(false),
            path = `/api/v1/books/${s.bookId}/print-pdf`;
        expect(
            (await request(app).post(path).auth(s.token, { type: 'bearer' }).send({})).status,
        ).toBe(404);
        const id = randomUUID();
        await pool.query(
            `INSERT INTO book_versions(id,book_id,version_no,schema_version,manifest_public_id,mind_groups,page_count,ar_page_count,total_size_bytes)
            VALUES ($1,$2,1,1,'legacy','[]',2,1,1000)`,
            [id, s.bookId],
        );
        await pool.query(
            "UPDATE books SET current_version_id=$2,slug=$3,status='PUBLISHED',visibility='UNLISTED' WHERE id=$1",
            [s.bookId, id, `b-${s.bookId}`],
        );
        const response = await request(app).post(path).auth(s.token, { type: 'bearer' }).send({});
        expect(response.status).toBe(400);
        expect(response.body.error.message).toContain('xuất bản lại');
    });
    it('prints the frozen version even after the draft title/geometry are edited', async () => {
        const s = await setup(),
            job = await enqueue(s),
            p = await pipeline();
        await pool.query(
            "UPDATE books SET title='Bản nháp mới',page_width_mm=148,page_aspect=1.419 WHERE id=$1",
            [s.bookId],
        );
        expect(await runJob(job, p.handler)).toBe('done');
        const bytes = [...p.uploads.values()][0] as Buffer,
            pdf = await PDFDocument.load(bytes),
            v = (await versions(s))[0];
        expect(pdf.getTitle()).toContain(s.source.title);
        expect(pdf.getPages()[2]?.getTrimBox().width).toBeCloseTo((210 * 72) / 25.4, 5);
        expect(v.print_pdf_public_id).toBe([...p.uploads.keys()][0]);
        expect((await jobState(job)).result.kind).toBe('PRINT');
        expect(
            (
                await pool.query(
                    "SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='JOB_SUCCEEDED'",
                    [s.owner],
                )
            ).rows[0].n,
        ).toBeGreaterThanOrEqual(2);
    });
    it('keeps the first PRINT pointer while later variants and marker sheets get their own job URLs', async () => {
        const s = await setup(),
            p = await pipeline();
        const first = await enqueue(s);
        expect(await runJob(first, p.handler)).toBe('done');
        const initial = (await versions(s))[0].print_pdf_public_id;
        const second = await enqueue(s, { qrMode: 'ALL_AR_PAGES', bleedMm: 0 });
        expect(await runJob(second, p.handler)).toBe('done');
        const stickers = await enqueue(s, { kind: 'MARKER_SHEET' });
        expect(await runJob(stickers, p.handler)).toBe('done');
        expect((await versions(s))[0].print_pdf_public_id).toBe(initial);
        expect(new Set([first, second, stickers].map((id) => id)).size).toBe(3);
        expect(p.uploads.size).toBe(3);
        expect((await jobState(stickers)).result.kind).toBe('MARKER_SHEET');
    });
    it('refuses commit if a new publication becomes current during upload', async () => {
        const s = await setup(),
            job = await enqueue(s),
            p = await pipeline(s.publishJob);
        expect(await runJob(job, p.handler)).toBe('failed');
        expect((await jobState(job)).error.code).toBe('PRINT_STALE');
        expect((await versions(s)).every((v) => v.print_pdf_public_id === null)).toBe(true);
    });
    it('refuses commit after unpublish and preserves the version PDF pointer', async () => {
        const s = await setup(),
            job = await enqueue(s),
            p = await pipeline(async () => {
                await pool.query("UPDATE books SET visibility='PRIVATE' WHERE id=$1", [s.bookId]);
            });
        expect(await runJob(job, p.handler)).toBe('failed');
        expect((await versions(s))[0].print_pdf_public_id).toBeNull();
    });
    it('rolls back the PDF pointer when the runner transaction fails after callback', async () => {
        const s = await setup(),
            job = await enqueue(s),
            p = await pipeline();
        const broken: JobHandler = (ctx) =>
            p.handler({
                ...ctx,
                onSuccess: (commit) =>
                    ctx.onSuccess(async (db) => {
                        await commit(db);
                        throw new JobError('TEST_ROLLBACK', 'test');
                    }),
            });
        expect(await runJob(job, broken)).toBe('failed');
        expect((await versions(s))[0].print_pdf_public_id).toBeNull();
    });
    it('retries temporary storage failure without publishing a result and ignores redelivery after success', async () => {
        const s = await setup(),
            job = await enqueue(s),
            p = await pipeline();
        p.storage.upload = async () => {
            throw new JobError('PRINT_STORAGE_ERROR', 'retry', true);
        };
        await expect(runJob(job, p.handler)).rejects.toMatchObject({ retry: true });
        expect((await jobState(job)).result).toBeNull();
        const next = await pipeline();
        expect(await runJob(job, next.handler)).toBe('done');
        expect(await runJob(job, next.handler)).toBe('skipped');
        expect(next.uploads.size).toBe(1);
    });
});
