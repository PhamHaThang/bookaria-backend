import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { setMediaStorage } from '../../../lib';
import { PageSettingsSchema, SceneSchema } from '../../../schema';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp(),
    headers = (token: string) => ({ Authorization: `Bearer ${token}` });
const empty = SceneSchema.parse({ schemaVersion: 1, objects: [] });
suite('whole-book draft commits', () => {
    let owner: { token: string; id: string }, other: { token: string; id: string };
    async function account() {
        const response = await request(app)
            .post('/api/v1/auth/register')
            .send({
                email: `draft-${randomUUID()}@example.com`,
                password: 'Matkhau-123',
                displayName: 'Draft',
            });
        expect(response.status).toBe(201);
        return {
            token: response.body.data.accessToken as string,
            id: response.body.data.user.id as string,
        };
    }
    async function asset(userId = owner.id, type = 'IMAGE', status = 'READY') {
        const { rows } = await pool.query(
            `INSERT INTO assets (owner_id,type,name,original_public_id,resource_type,format,size_bytes,status,meta) VALUES ($1,$2,'draft',$3,$4,$5,100,$6,'{"width":640,"height":480}') RETURNING id`,
            [
                userId,
                type,
                `bookaria/${userId}/${randomUUID()}`,
                type === 'AUDIO' ? 'video' : 'image',
                type === 'AUDIO' ? 'mp3' : 'png',
                status,
            ],
        );
        return rows[0].id as string;
    }
    async function snapshot(bookId: string, token = owner.token) {
        return request(app).get(`/api/v1/books/${bookId}/draft`).set(headers(token));
    }
    async function commit(bookId: string, body: Record<string, unknown>, token = owner.token) {
        return request(app).put(`/api/v1/books/${bookId}/draft`).set(headers(token)).send(body);
    }
    async function fixture() {
        const response = await request(app)
            .post('/api/v1/books')
            .set(headers(owner.token))
            .send({ title: 'Draft book' });
        const bookId = response.body.data.book.id as string,
            image = await asset();
        const ids: string[] = [];
        for (let index = 0; index < 2; index++) {
            const page = await request(app)
                .post(`/api/v1/books/${bookId}/pages`)
                .set(headers(owner.token))
                .send({ imageAssetId: image, title: `Page ${index + 1}` });
            expect(page.status).toBe(201);
            ids.push(page.body.data.page.id);
        }
        return { bookId, image, ids, base: (await snapshot(bookId)).body.data };
    }
    beforeAll(async () => {
        setMediaStorage({
            signUpload: () => {
                throw new Error('unused');
            },
            inspect: async () => null,
            destroy: async () => {},
            deliveryUrl: ({ publicId }) => `https://fake.test/${publicId}`,
        });
        owner = await account();
        other = await account();
    });
    afterAll(() => setMediaStorage(undefined));
    it('commits creation, deletion, title, settings, scene and order in one transaction; retries do not duplicate', async () => {
        const { bookId, ids, image, base } = await fixture(),
            newId = randomUUID(),
            audio = await asset(owner.id, 'AUDIO');
        const body = {
            revision: base.revision,
            order: [newId, ids[1]],
            changes: [
                {
                    id: newId,
                    title: 'New local page',
                    imageAssetId: image,
                    scene: empty,
                    settings: PageSettingsSchema.parse({ backgroundAudioAssetId: audio }),
                },
                { id: ids[1], title: 'Renamed', scene: empty },
            ],
        };
        const response = await commit(bookId, body);
        expect(response.status).toBe(200);
        expect(response.body.data.snapshot.pages.map((page: { id: string }) => page.id)).toEqual(
            body.order,
        );
        expect(response.body.data.snapshot.pages[1].title).toBe('Renamed');
        expect(
            response.body.data.pages.find((page: { id: string }) => page.id === newId).settings
                .backgroundAudioAssetId,
        ).toBe(audio);
        expect(
            (
                await pool.query('SELECT * FROM page_assets WHERE page_id=$1 AND asset_id=$2', [
                    newId,
                    audio,
                ])
            ).rowCount,
        ).toBe(1);
        expect((await pool.query('SELECT * FROM pages WHERE id=$1', [ids[0]])).rowCount).toBe(0);
        const repeat = await commit(bookId, body);
        expect(repeat.status).toBe(200);
        expect(repeat.body.data.snapshot.revision).toBe(response.body.data.snapshot.revision);
        expect((await pool.query('SELECT * FROM pages WHERE book_id=$1', [bookId])).rowCount).toBe(
            2,
        );
    });
    it('rolls back title, order and deletions when any new page is invalid', async () => {
        const { bookId, ids, base } = await fixture();
        const response = await commit(bookId, {
            revision: base.revision,
            order: [ids[1], randomUUID()],
            changes: [{ id: ids[1], title: 'Must roll back' }],
        });
        expect(response.status).toBe(400);
        expect((await snapshot(bookId)).body.data).toEqual(base);
    });
    it('rejects stale edits without overwriting concurrent scene changes', async () => {
        const { bookId, ids, base } = await fixture();
        const changed = await request(app)
            .patch(`/api/v1/pages/${ids[0]}/scene`)
            .set(headers(owner.token))
            .send({ revision: 0, scene: empty });
        expect(changed.status).toBe(200);
        const response = await commit(bookId, {
            revision: base.revision,
            order: ids,
            changes: [{ id: ids[0], title: 'Stale' }],
        });
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('REVISION_CONFLICT');
        expect((await snapshot(bookId)).body.data.pages[0].title).toBe('Page 1');
    });
    it('checks ownership and rejects foreign page ids and foreign assets', async () => {
        const { bookId, ids, base } = await fixture(),
            foreign = await asset(other.id);
        expect((await snapshot(bookId, other.token)).status).toBe(404);
        expect(
            (
                await commit(
                    bookId,
                    { revision: base.revision, order: ids, changes: [] },
                    other.token,
                )
            ).status,
        ).toBe(404);
        const response = await commit(bookId, {
            revision: base.revision,
            order: ids,
            changes: [{ id: ids[0], imageAssetId: foreign }],
        });
        expect(response.status).toBe(400);
        expect((await snapshot(bookId)).body.data.revision).toBe(base.revision);
        const elsewhere = await fixture();
        expect(
            (
                await commit(bookId, {
                    revision: base.revision,
                    order: [...ids, elsewhere.ids[0]],
                    changes: [{ id: elsewhere.ids[0], imageAssetId: elsewhere.image }],
                })
            ).status,
        ).toBe(400);
    });
    it('rejects processing images and duplicate page ids', async () => {
        const { bookId, ids, base } = await fixture(),
            processing = await asset(owner.id, 'IMAGE', 'PROCESSING');
        expect(
            (
                await commit(bookId, {
                    revision: base.revision,
                    order: ids,
                    changes: [{ id: ids[0], imageAssetId: processing }],
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await commit(bookId, {
                    revision: base.revision,
                    order: [ids[0], ids[0]],
                    changes: [],
                })
            ).status,
        ).toBe(400);
        expect((await snapshot(bookId)).body.data.revision).toBe(base.revision);
    });
    it('protects publication jobs and supports intentionally saving an empty book', async () => {
        const { bookId, ids, base } = await fixture();
        const { rows } = await pool.query(
            `INSERT INTO jobs (type,status,ref_type,ref_id,created_by) VALUES ('PUBLISH_BOOK','RUNNING','BOOK',$1,$2) RETURNING id`,
            [bookId, owner.id],
        );
        expect(
            (await commit(bookId, { revision: base.revision, order: [], changes: [] })).status,
        ).toBe(409);
        expect(
            (await snapshot(bookId)).body.data.pages.map((page: { id: string }) => page.id),
        ).toEqual(ids);
        await pool.query(`UPDATE jobs SET status='SUCCEEDED' WHERE id=$1`, [rows[0].id]);
        const response = await commit(bookId, { revision: base.revision, order: [], changes: [] });
        expect(response.status).toBe(200);
        expect(response.body.data.snapshot.pages).toEqual([]);
    });
    it('serializes concurrent commits so exactly one distinct edit wins', async () => {
        const { bookId, ids, base } = await fixture();
        const responses = await Promise.all(
            ['First', 'Second'].map((title) =>
                commit(bookId, {
                    revision: base.revision,
                    order: ids,
                    changes: [{ id: ids[0], title }],
                }),
            ),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        const winner = responses.find((response) => response.status === 200);
        expect((await snapshot(bookId)).body.data.pages[0].title).toBe(
            winner?.body.data.snapshot.pages[0].title,
        );
    });
    it('offers a read-only image layout for pages that do not exist on the server yet', async () => {
        const { bookId, image } = await fixture(),
            before = (await snapshot(bookId)).body.data;
        const response = await request(app)
            .post(`/api/v1/books/${bookId}/draft/image-layout`)
            .set(headers(owner.token))
            .send({ imageAssetId: image, aspect: 1.5 });
        expect(response.status).toBe(200);
        expect(response.body.data.assetId).toBe(image);
        expect((await snapshot(bookId)).body.data).toEqual(before);
    });
    it('accepts a multi-page body above the default JSON limit and enforces the draft limit', async () => {
        const { bookId, ids, base } = await fixture();
        expect(
            (
                await commit(bookId, {
                    revision: base.revision,
                    order: ids,
                    changes: [],
                    extra: 'x'.repeat(130_000),
                })
            ).status,
        ).toBe(200);
        expect((await commit(bookId, { extra: 'x'.repeat(9 * 1024 * 1024) })).status).toBe(413);
    });
});
