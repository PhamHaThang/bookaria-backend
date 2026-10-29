import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { type MediaStorage, setMediaStorage } from '../../../lib';
import { PAGE_ASPECT } from '../../books/books.constants';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp();
const files = new Set<string>();
const storage: MediaStorage = {
    signUpload: () => {
        throw new Error('unused');
    },
    destroy: async () => {},
    inspect: async (_type, publicId) =>
        files.has(publicId)
            ? { publicId, bytes: 100, format: '', width: null, height: null, durationSec: null }
            : null,
    deliveryUrl: ({ publicId, transform }) =>
        `https://fake.test/${transform ? `${transform}/` : ''}${publicId}`,
};
async function author() {
    const r = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `source-${crypto.randomUUID()}@example.com`,
            password: 'Matkhau-123',
            displayName: 'An',
        });
    expect(r.status).toBe(201);
    return { id: r.body.data.user.id as string, token: r.body.data.accessToken as string };
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
async function image(owner: string, width = 1600, height = 2263) {
    const r = await pool.query(
        `INSERT INTO assets (owner_id,type,name,original_public_id,resource_type,format,size_bytes,status,meta)
        VALUES ($1,'IMAGE','source test',$2,'image','jpg',100,'READY',$3::jsonb) RETURNING id`,
        [owner, `bookaria/${owner}/${crypto.randomUUID()}`, JSON.stringify({ width, height })],
    );
    return r.rows[0].id as string;
}
async function fixture() {
    const user = await author();
    const b = await request(app)
        .post('/api/v1/books')
        .set(auth(user.token))
        .send({ title: 'Ảnh nguồn' });
    const bookId = b.body.data.book.id as string;
    const source = await image(user.id, 1200, 600);
    const p = await request(app)
        .post(`/api/v1/books/${bookId}/pages`)
        .set(auth(user.token))
        .send({ imageAssetId: source });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const pageId = p.body.data.page.id as string;
    const read = () => request(app).get(`/api/v1/pages/${pageId}`).set(auth(user.token));
    return { user, bookId, source, pageId, read };
}
suite('single page source and atomic layouts', () => {
    beforeAll(() => setMediaStorage(storage));
    afterAll(() => setMediaStorage(undefined));
    it('derives each paper size from one source, protects it and duplicates its reference', async () => {
        const f = await fixture();
        const initial = (await f.read()).body.data;
        expect(initial.image).toMatchObject({ assetId: f.source, width: 1600, height: 2263 });
        expect(initial.image.url).toContain('c_pad,w_1600,h_2263');
        const copy = await request(app)
            .post(`/api/v1/pages/${f.pageId}/duplicate`)
            .set(auth(f.user.token));
        expect(copy.status).toBe(201);
        const changed = await request(app)
            .patch(`/api/v1/books/${f.bookId}`)
            .set(auth(f.user.token))
            .send({ pageFormat: 'CUSTOM', pageAspect: 0.5 });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        expect((await f.read()).body.data.image).toMatchObject({
            assetId: f.source,
            width: 1600,
            height: 800,
        });
        const rows = (
            await pool.query('SELECT image_asset_id FROM pages WHERE book_id=$1', [f.bookId])
        ).rows;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.image_asset_id === f.source)).toBe(true);
        expect(
            Number(
                (
                    await pool.query('SELECT count(*) AS count FROM assets WHERE owner_id=$1', [
                        f.user.id,
                    ])
                ).rows[0].count,
            ),
        ).toBe(1);
        expect(
            (await request(app).delete(`/api/v1/assets/${f.source}`).set(auth(f.user.token)))
                .status,
        ).toBe(409);
    });
    it('validates batch membership and source identity, rolls back geometry and safely retries', async () => {
        const f = await fixture();
        await request(app)
            .post(`/api/v1/books/${f.bookId}/pages`)
            .set(auth(f.user.token))
            .send({ imageAssetId: f.source });
        const plan = await request(app)
            .post(`/api/v1/books/${f.bookId}/pages/layout`)
            .set(auth(f.user.token))
            .send({ aspect: 0.5 });
        expect(plan.status).toBe(200);
        expect(
            plan.body.data.pages.every(
                (p: { layout: { assetId: string; url: string } }) =>
                    p.layout.assetId === f.source && p.layout.url.includes('c_pad,w_1600,h_800'),
            ),
        ).toBe(true);
        const entries = plan.body.data.pages.map(
            (p: { pageId: string; expectedImageAssetId: string; markerMode: string }) => ({
                pageId: p.pageId,
                expectedImageAssetId: p.expectedImageAssetId,
                expectedMarkerMode: p.markerMode,
            }),
        );
        const update = (pageImages: unknown) =>
            request(app).patch(`/api/v1/books/${f.bookId}`).set(auth(f.user.token)).send({
                pageFormat: 'CUSTOM',
                pageAspect: 0.5,
                expectedPageAspect: plan.body.data.pageAspect,
                pageImages,
            });
        expect((await update(entries.slice(1))).status).toBe(400);
        expect(
            (await update([entries[0], { ...entries[1], pageId: crypto.randomUUID() }])).status,
        ).toBe(400);
        expect(
            (
                await update([
                    entries[0],
                    { ...entries[1], expectedImageAssetId: crypto.randomUUID() },
                ])
            ).status,
        ).toBe(409);
        expect(
            Number(
                (await pool.query('SELECT page_aspect FROM books WHERE id=$1', [f.bookId])).rows[0]
                    .page_aspect,
            ),
        ).toBe(PAGE_ASPECT.A4);
        expect((await update(entries)).status).toBe(200);
        expect((await update(entries)).status).toBe(200);
        expect(
            (
                await update([
                    entries[0],
                    { ...entries[1], expectedImageAssetId: crypto.randomUUID() },
                ])
            ).status,
        ).toBe(409);
        const stranger = await author();
        expect(
            (
                await request(app)
                    .post(`/api/v1/pages/${f.pageId}/image-layout`)
                    .set(auth(stranger.token))
                    .send({ aspect: 1 })
            ).status,
        ).toBe(404);
        expect(
            (
                await request(app)
                    .post(`/api/v1/books/${f.bookId}/pages/layout`)
                    .set(auth(stranger.token))
                    .send({ aspect: 1 })
            ).status,
        ).toBe(404);
        const foreignImage = await image(stranger.id);
        expect(
            (
                await request(app)
                    .post(`/api/v1/pages/${f.pageId}/image-layout`)
                    .set(auth(f.user.token))
                    .send({ aspect: 1, imageAssetId: foreignImage })
            ).status,
        ).toBe(404);
    });
    it('requires updated recognition on resize, queues scoring once and retries only the identical mind', async () => {
        const f = await fixture();
        const oldMind = `bookaria/${f.user.id}/old.mind`,
            newMind = `bookaria/${f.user.id}/new.mind`;
        files.add(oldMind);
        files.add(newMind);
        const marker = await request(app)
            .put(`/api/v1/pages/${f.pageId}/marker`)
            .set(auth(f.user.token))
            .send({ mode: 'CUSTOM_MARKER', markerMindPublicId: oldMind });
        expect(marker.status, JSON.stringify(marker.body)).toBe(202);
        await pool.query("UPDATE jobs SET status='SUCCEEDED',finished_at=now() WHERE ref_id=$1", [
            f.pageId,
        ]);
        const geometry = {
            pageFormat: 'CUSTOM',
            pageAspect: 0.5,
            expectedPageAspect: PAGE_ASPECT.A4,
        };
        const update = (extra: object) =>
            request(app)
                .patch(`/api/v1/books/${f.bookId}`)
                .set(auth(f.user.token))
                .send({ ...geometry, ...extra });
        expect((await update({})).status).toBe(400);
        const entry = {
            pageId: f.pageId,
            expectedImageAssetId: f.source,
            expectedMarkerMode: 'CUSTOM_MARKER',
            markerMindPublicId: newMind,
        };
        const missing = { ...entry, markerMindPublicId: undefined };
        expect((await update({ pageImages: [missing] })).status).toBe(400);
        const saved = await update({ pageImages: [entry] });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect((await update({ pageImages: [entry] })).status).toBe(200);
        const row = (
            await pool.query(
                'SELECT image_asset_id,marker_mind_public_id,marker_score FROM pages WHERE id=$1',
                [f.pageId],
            )
        ).rows[0];
        expect(row).toMatchObject({
            image_asset_id: f.source,
            marker_mind_public_id: newMind,
            marker_score: null,
        });
        expect(
            (
                await pool.query(
                    "SELECT id FROM jobs WHERE ref_id=$1 AND status='QUEUED' AND type='SCORE_MARKER'",
                    [f.pageId],
                )
            ).rows,
        ).toHaveLength(1);
        expect(
            (await update({ pageImages: [{ ...entry, markerMindPublicId: oldMind }] })).status,
        ).toBe(409);
    });
});
