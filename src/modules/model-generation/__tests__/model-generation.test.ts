import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { env } from '../../../config';
import { pool } from '../../../db';
import { type MediaStorage, type StoredFile, setMediaStorage } from '../../../lib';
import { createGenerateModelHandler } from '../../../worker/handlers/generate-model';
import { runJob } from '../../../worker/runner';
import { purgeExpiredModelInput } from '../../../worker/storage-maintenance';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp();
const files = new Map<string, StoredFile>();
const fakeStorage: MediaStorage = {
    signUpload: ({ publicId }) => ({
        uploadUrl: 'https://test.r2.cloudflarestorage.com/input',
        objectKey: publicId,
        method: 'PUT',
        headers: {},
        expiresAt: new Date(Date.now() + 900_000),
    }),
    inspect: async (_type, key) => files.get(key) ?? null,
    destroy: vi.fn(async () => {}),
    deliveryUrl: () => 'https://assets.test/model.glb',
    prepareImage: async () => 'https://assets.test/image.png',
};
const original = { key: env.RUNPOD_MODEL_API_KEY, endpoint: env.RUNPOD_MODEL_ENDPOINT_ID };
async function author() {
    const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `${randomUUID()}@example.com`,
            password: 'Matkhau-123',
            displayName: 'Tác giả',
        });
    expect(response.status).toBe(201);
    return {
        id: response.body.data.user.id as string,
        headers: { Authorization: `Bearer ${response.body.data.accessToken}` },
    };
}
async function input(owner: Awaited<ReturnType<typeof author>>) {
    const image = await sharp({
        create: { width: 16, height: 16, channels: 3, background: 'white' },
    })
        .png()
        .toBuffer();
    const response = await request(app)
        .post('/api/v1/assets/upload-signature')
        .set(owner.headers)
        .send({
            purpose: 'MODEL_INPUT',
            fileName: 'Rùa.png',
            mimeType: 'image/png',
            sizeBytes: image.length,
        });
    expect(response.status).toBe(200);
    const { assetId, objectKey } = response.body.data;
    expect(objectKey).toBe(`bookaria/model-inputs/${owner.id}/${assetId}`);
    files.set(objectKey, {
        publicId: objectKey,
        bytes: image.length,
        width: 16,
        height: 16,
        durationSec: null,
        format: 'png',
    });
    return { assetId: assetId as string, key: objectKey as string, image };
}
const submit = (owner: Awaited<ReturnType<typeof author>>, inputId: string) =>
    request(app).post('/api/v1/assets/model-generations').set(owner.headers).send({ inputId });

suite('image-to-3D API and worker', () => {
    beforeAll(() => {
        env.RUNPOD_MODEL_API_KEY = 'test';
        env.RUNPOD_MODEL_ENDPOINT_ID = 'test';
        setMediaStorage(fakeStorage);
    });
    afterAll(() => {
        env.RUNPOD_MODEL_API_KEY = original.key;
        env.RUNPOD_MODEL_ENDPOINT_ID = original.endpoint;
        setMediaStorage(undefined);
    });

    it('requires authentication and enforces input and job ownership', async () => {
        expect((await request(app).get('/api/v1/assets/model-generations')).status).toBe(401);
        const owner = await author();
        const other = await author();
        const source = await input(owner);
        expect((await submit(other, source.assetId)).status).toBe(404);
        const job = await submit(owner, source.assetId);
        expect(job.status).toBe(202);
        const list = await request(app).get('/api/v1/assets/model-generations').set(other.headers);
        expect(list.body.data).toEqual([]);
        expect(
            (await request(app).get(`/api/v1/jobs/${job.body.data.id}`).set(other.headers)).status,
        ).toBe(404);
        expect(
            (
                await request(app)
                    .post(`/api/v1/assets/${source.assetId}/complete`)
                    .set(owner.headers)
                    .send({})
            ).status,
        ).toBe(422);
    });
    it('keeps the generation list readable when legacy jobs have no input name', async () => {
        const owner = await author();
        await pool.query(
            `INSERT INTO jobs (type,status,ref_type,ref_id,created_by,payload)
             VALUES ('GENERATE_MODEL','FAILED','ASSET',gen_random_uuid(),$1,'{}'::jsonb)`,
            [owner.id],
        );
        const current = await submit(owner, (await input(owner)).assetId);
        expect(current.status).toBe(202);
        const response = await request(app)
            .get('/api/v1/assets/model-generations')
            .set(owner.headers);
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: current.body.data.id, name: 'Rùa' }),
                expect.objectContaining({ status: 'FAILED', name: 'Mô hình từ ảnh' }),
            ]),
        );
    });
    it('reuses the same task on concurrent submissions and blocks a second active generation', async () => {
        const owner = await author();
        const source = await input(owner);
        const responses = await Promise.all([
            submit(owner, source.assetId),
            submit(owner, source.assetId),
        ]);
        expect(responses.map((response) => response.status)).toEqual([202, 202]);
        expect(responses[0]?.body.data.id).toBe(responses[1]?.body.data.id);
        expect((await submit(owner, (await input(owner)).assetId)).status).toBe(409);
    });
    it('checks actual pixels, expiration and available quota before submitting a GPU task', async () => {
        const owner = await author();
        const source = await input(owner);
        const stored = files.get(source.key);
        if (!stored) throw new Error('missing input fixture');
        stored.width = 20_000;
        stored.height = 20_000;
        expect((await submit(owner, source.assetId)).status).toBe(422);
        stored.width = 16;
        stored.height = 16;
        await pool.query(
            "UPDATE upload_intents SET expires_at=NOW()-INTERVAL '1 minute' WHERE asset_id=$1",
            [source.assetId],
        );
        expect((await submit(owner, source.assetId)).status).toBe(404);
        const fresh = await input(owner);
        await pool.query('UPDATE users SET storage_quota_bytes=1000 WHERE id=$1', [owner.id]);
        expect((await submit(owner, fresh.assetId)).status).toBe(422);
    });
    it('stores the generated model and queues existing optimization atomically', async () => {
        const owner = await author();
        const source = await input(owner);
        const response = await submit(owner, source.assetId);
        const blobs = new Map([[source.key, source.image]]);
        const generate = vi.fn(async (_image, _signal, accepted) => {
            await accepted('remote-job');
            return Buffer.from('generated-model');
        });
        const handler = createGenerateModelHandler(
            {
                get: async (key) => {
                    const bytes = blobs.get(key);
                    if (!bytes) throw new Error('missing');
                    return bytes;
                },
                put: async (key, bytes) => {
                    blobs.set(key, Buffer.from(bytes));
                },
                head: async (key) =>
                    blobs.has(key)
                        ? new Headers({ 'content-length': String(blobs.get(key)?.length) })
                        : null,
            },
            generate,
        );
        expect(await runJob(response.body.data.id, handler, new AbortController().signal)).toBe(
            'done',
        );
        expect(generate).toHaveBeenCalledTimes(1);
        expect(
            (
                await pool.query('SELECT status,format,name FROM assets WHERE id=$1', [
                    source.assetId,
                ])
            ).rows[0],
        ).toMatchObject({ status: 'PROCESSING', format: 'glb', name: 'Rùa' });
        expect(
            (
                await pool.query("SELECT id FROM jobs WHERE type='OPTIMIZE_ASSET' AND ref_id=$1", [
                    source.assetId,
                ])
            ).rowCount,
        ).toBe(1);
        expect(await runJob(response.body.data.id, handler, new AbortController().signal)).toBe(
            'skipped',
        );
        expect(generate).toHaveBeenCalledTimes(1);
    });
    it('enforces the hourly GPU job limit even when earlier tasks have failed', async () => {
        const owner = await author();
        const source = await input(owner);
        await pool.query(
            `INSERT INTO jobs (type,status,ref_type,ref_id,created_by,payload)
            SELECT 'GENERATE_MODEL','FAILED','ASSET',gen_random_uuid(),$1,'{"modelInputName":"test"}'::jsonb FROM generate_series(1,6)`,
            [owner.id],
        );
        expect((await submit(owner, source.assetId)).status).toBe(429);
    });
    it('never submits again after an earlier worker claimed the paid request', async () => {
        const owner = await author();
        const source = await input(owner);
        const response = await submit(owner, source.assetId);
        await pool.query(
            `UPDATE jobs SET payload=payload || '{"modelSubmitted":true}'::jsonb WHERE id=$1`,
            [response.body.data.id],
        );
        const generate = vi.fn();
        const handler = createGenerateModelHandler(
            { get: async () => source.image, head: async () => null, put: vi.fn() },
            generate,
        );
        expect(await runJob(response.body.data.id, handler, new AbortController().signal)).toBe(
            'failed',
        );
        expect(generate).not.toHaveBeenCalled();
    });
    it('retains active inputs and cleans expired failed inputs and orphan outputs', async () => {
        const owner = await author();
        const source = await input(owner);
        const response = await submit(owner, source.assetId);
        await pool.query(
            "UPDATE upload_intents SET expires_at=NOW()-INTERVAL '1 hour' WHERE asset_id=$1",
            [source.assetId],
        );
        const destroy = vi.fn(async () => {});
        expect(
            await purgeExpiredModelInput(source.assetId, { destroy }, new AbortController().signal),
        ).toBe(false);
        expect(destroy).not.toHaveBeenCalled();
        await pool.query("UPDATE jobs SET status='FAILED' WHERE id=$1", [response.body.data.id]);
        expect(
            await purgeExpiredModelInput(source.assetId, { destroy }, new AbortController().signal),
        ).toBe(true);
        expect(destroy).toHaveBeenCalledWith('image', source.key, expect.any(AbortSignal));
        expect(destroy).toHaveBeenCalledWith(
            'image',
            `bookaria/${owner.id}/${source.assetId}`,
            expect.any(AbortSignal),
        );
    });
});
