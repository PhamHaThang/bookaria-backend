import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { createR2Storage, derivativeKey, setMediaStorage } from '../../../lib/storage';
import { account, fakeR2 } from '../../../test/r2';
import { verifyFixtureEmail } from '../../../test/verified-author';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false }),
    fake = fakeR2();
async function author() {
    const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `invalid-media-${randomUUID()}@example.test`,
            password: 'Matkhau-123',
            displayName: 'Test',
        });
    expect(response.status).toBe(201);
    await verifyFixtureEmail(response.body.data.user.id);
    return response.body.data.accessToken as string;
}
async function uploadIntent(token: string, fileName: string, mimeType: string, bytes: Buffer) {
    const response = await request(app)
        .post('/api/v1/assets/upload-signature')
        .auth(token, { type: 'bearer' })
        .send({ purpose: 'ASSET', fileName, mimeType, sizeBytes: bytes.length });
    expect(response.status).toBe(200);
    const { assetId, objectKey } = response.body.data;
    fake.files.set(objectKey, { bytes, type: mimeType, format: fileName.split('.').at(-1) ?? '' });
    return { assetId, objectKey };
}
suite('prepared R2 image uploads', () => {
    beforeAll(() => setMediaStorage(createR2Storage(account, fake.network)));
    afterAll(() => setMediaStorage(undefined));
    it.each(['ASSET', 'AVATAR'])(
        'returns a ready direct R2 thumbnail for %s before completion',
        async (purpose) => {
            const registered = await request(app)
                .post('/api/v1/auth/register')
                .send({
                    email: `image-${purpose}-${Date.now()}@example.test`,
                    password: 'Matkhau-123',
                    displayName: 'Test',
                });
            expect(registered.status).toBe(201);
            await verifyFixtureEmail(registered.body.data.user.id);
            const token = registered.body.data.accessToken as string;
            const original = await sharp({
                create: { width: 400, height: 200, channels: 3, background: 'red' },
            })
                .png()
                .toBuffer();
            const signed = await request(app)
                .post('/api/v1/assets/upload-signature')
                .auth(token, { type: 'bearer' })
                .send({
                    purpose,
                    fileName: 'image.png',
                    mimeType: 'image/png',
                    sizeBytes: original.length,
                });
            expect(signed.status).toBe(200);
            const { assetId, objectKey } = signed.body.data;
            fake.files.set(objectKey, { bytes: original, type: 'image/png', format: 'png' });
            const completed = await request(app)
                .post(`/api/v1/assets/${assetId}/complete`)
                .auth(token, { type: 'bearer' })
                .send({});
            expect(completed.status).toBe(200);
            const transform = purpose === 'AVATAR' ? 'avatar' : 'asset-preview';
            const url = `https://assets.bookaria.test/${derivativeKey(objectKey, transform)}`;
            expect(completed.body.data.asset.thumbnailUrl).toBe(url);
            const image = fake.files.get(derivativeKey(objectKey, transform));
            expect(await sharp(image?.bytes).metadata()).toMatchObject({
                width: purpose === 'AVATAR' ? 256 : 320,
                height: purpose === 'AVATAR' ? 256 : 160,
            });
            const before = fake.network.mock.calls.length;
            expect(
                (
                    await request(app)
                        .post(`/api/v1/assets/${assetId}/complete`)
                        .auth(token, { type: 'bearer' })
                        .send({})
                ).status,
            ).toBe(200);
            expect(fake.network.mock.calls.length).toBe(before);
            if (purpose === 'ASSET') {
                const created = await pool.query(
                    "INSERT INTO books(owner_id,title,cover_asset_id) VALUES ($1,'Prepared cover',$2) RETURNING id",
                    [registered.body.data.user.id, assetId],
                );
                const list = await request(app)
                    .get('/api/v1/books')
                    .auth(token, { type: 'bearer' });
                expect(list.status).toBe(200);
                expect(
                    list.body.data.find((b: { id: string }) => b.id === created.rows[0].id)
                        ?.coverUrl,
                ).toBe(url);
                const added = await request(app)
                    .post(`/api/v1/books/${created.rows[0].id}/pages`)
                    .auth(token, { type: 'bearer' })
                    .send({ imageAssetId: assetId });
                expect(added.status).toBe(201);
                const read = () =>
                    request(app)
                        .get(`/api/v1/pages/${added.body.data.page.id}`)
                        .auth(token, { type: 'bearer' });
                const summaries = await request(app)
                    .get(`/api/v1/books/${created.rows[0].id}/pages`)
                    .auth(token, { type: 'bearer' });
                expect(summaries.status).toBe(200);
                expect(fake.files.has(derivativeKey(objectKey, 'page-320-453'))).toBe(true);
                expect(fake.files.has(derivativeKey(objectKey, 'page-1600-2263'))).toBe(false);
                const page = await read();
                expect(page.status).toBe(200);
                expect(page.body.data.image.url).toBe(
                    `${account.publicUrl}/${derivativeKey(objectKey, 'page-1600-2263')}`,
                );
                expect(page.body.data.thumbnailUrl).toBe(
                    `${account.publicUrl}/${derivativeKey(objectKey, 'page-320-453')}`,
                );
                expect(
                    await sharp(
                        fake.files.get(derivativeKey(objectKey, 'page-1600-2263'))?.bytes,
                    ).metadata(),
                ).toMatchObject({ width: 1600, height: 2263, format: 'jpeg' });
                const afterPrepared = fake.network.mock.calls.length;
                expect((await read()).status).toBe(200);
                expect(fake.network.mock.calls.length).toBe(afterPrepared);
                const changed = await request(app)
                    .patch(`/api/v1/books/${created.rows[0].id}`)
                    .auth(token, { type: 'bearer' })
                    .send({ pageFormat: 'CUSTOM', pageAspect: 0.5 });
                expect(changed.status).toBe(200);
                const resized = await read();
                expect(resized.body.data.image.url).toBe(
                    `${account.publicUrl}/${derivativeKey(objectKey, 'page-1600-800')}`,
                );
                expect(fake.files.has(derivativeKey(objectKey, 'page-320-160'))).toBe(true);
                expect(fake.files.has(derivativeKey(objectKey, 'page-1600-2263'))).toBe(true);
                expect(fake.files.has(objectKey)).toBe(true);
            } else {
                const profile = await request(app)
                    .patch('/api/v1/me')
                    .auth(token, { type: 'bearer' })
                    .send({ avatarAssetId: assetId });
                expect(profile.status).toBe(200);
                expect(profile.body.data.avatarUrl).toBe(url);
            }
        },
    );
    it.each([
        ['bad.png', 'image/png'],
        ['bad.wav', 'audio/wav'],
        ['bad.mp4', 'video/mp4'],
    ])('rejects corrupt %s with 422 and removes it from R2', async (name, type) => {
        const token = await author(),
            { assetId, objectKey } = await uploadIntent(token, name, type, Buffer.from('broken'));
        const response = await request(app)
            .post(`/api/v1/assets/${assetId}/complete`)
            .auth(token, { type: 'bearer' })
            .send({});
        expect(response.status).toBe(422);
        expect(response.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(fake.files.has(objectKey)).toBe(false);
        expect((await pool.query('SELECT id FROM assets WHERE id=$1', [assetId])).rowCount).toBe(0);
    });
    it('also rejects corrupt pixels after a valid image header passed inspection', async () => {
        const token = await author();
        const png = await sharp({
            create: { width: 400, height: 200, channels: 3, background: 'red' },
        })
            .png()
            .toBuffer();
        const index = png.indexOf(Buffer.from('IDAT'));
        png.fill(255, index + 4, index + 12);
        expect(await sharp(png).metadata()).toMatchObject({ width: 400, height: 200 });
        const { assetId, objectKey } = await uploadIntent(
            token,
            'broken-pixels.png',
            'image/png',
            png,
        );
        const response = await request(app)
            .post(`/api/v1/assets/${assetId}/complete`)
            .auth(token, { type: 'bearer' })
            .send({});
        expect(response.status).toBe(422);
        expect(response.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(fake.files.has(objectKey)).toBe(false);
        expect((await pool.query('SELECT id FROM assets WHERE id=$1', [assetId])).rowCount).toBe(0);
    });
    it('retains a valid upload after a transient storage failure and completes on retry', async () => {
        const token = await author();
        const png = await sharp({
            create: { width: 20, height: 20, channels: 3, background: 'red' },
        })
            .png()
            .toBuffer();
        const { assetId, objectKey } = await uploadIntent(token, 'retry.png', 'image/png', png);
        fake.network.mockRejectedValueOnce(new Error('R2 temporarily unavailable'));
        expect(
            (
                await request(app)
                    .post(`/api/v1/assets/${assetId}/complete`)
                    .auth(token, { type: 'bearer' })
                    .send({})
            ).status,
        ).toBe(500);
        expect(fake.files.has(objectKey)).toBe(true);
        expect(
            (
                await request(app)
                    .post(`/api/v1/assets/${assetId}/complete`)
                    .auth(token, { type: 'bearer' })
                    .send({})
            ).status,
        ).toBe(200);
    });
});
