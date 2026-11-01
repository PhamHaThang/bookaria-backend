import { encode } from '@msgpack/msgpack';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import {
    getMediaStorage,
    type MediaStorage,
    type StoredFile,
    setMediaStorage,
} from '../../../lib/cloudinary';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp(),
    base = '/api/v1/admin/bookaria-markers';
const mindBytes = encode({
    v: 2,
    dataList: [
        { targetImage: { width: 1024, height: 1024 }, matchingData: [{}], trackingData: [{}] },
    ],
});
const files = new Map<string, StoredFile>();
const signed: object[] = [];
const storage: MediaStorage = {
    signUpload(input) {
        signed.push(input);
        return {
            uploadUrl: `https://api.cloudinary.com/v1_1/test/${input.resourceType}/upload`,
            fields: {
                api_key: 'test',
                public_id: input.publicId,
                timestamp: 1,
                signature: 'signature',
            },
            expiresAt: new Date(Date.now() + 3600000),
        };
    },
    async inspect(_type, id) {
        return files.get(id) || null;
    },
    async destroy() {},
    deliveryUrl: ({ publicId }) => `https://files.example.com/${publicId}`,
};
suite('admin marker file registration', () => {
    let admin = '',
        author = '',
        owner = '',
        previous: MediaStorage | undefined;
    beforeAll(async () => {
        previous = getMediaStorage();
        setMediaStorage(storage);
        const create = async (name: string) => {
            const email = `markerupload-${name}-${Date.now()}@example.com`;
            const result = await request(app)
                .post('/api/v1/auth/register')
                .send({ email, password: 'Matkhau-123', displayName: name });
            expect(result.status).toBe(201);
            return {
                email,
                id: result.body.data.user.id as string,
                token: result.body.data.accessToken as string,
            };
        };
        const a = await create('admin'),
            b = await create('author');
        owner = a.id;
        author = b.token;
        await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [a.id]);
        admin = (
            await request(app)
                .post('/api/v1/auth/login')
                .send({ email: a.email, password: 'Matkhau-123' })
        ).body.data.accessToken;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(Uint8Array.from(mindBytes))),
        );
    });
    afterAll(() => {
        setMediaStorage(previous);
        vi.unstubAllGlobals();
    });
    const post = (path: string, body: object, token = admin) =>
        request(app)
            .post(base + path)
            .set('Authorization', `Bearer ${token}`)
            .send(body);
    const prepare = async () => {
        const result = await post('/upload-signature', {
            imageFormat: 'png',
            imageBytes: 1000,
            mindBytes: mindBytes.length,
        });
        expect(result.status).toBe(200);
        const value = result.body.data as { imagePublicId: string; mindPublicId: string };
        files.set(value.imagePublicId, {
            publicId: value.imagePublicId,
            bytes: 1000,
            format: 'png',
            width: 1024,
            height: 1024,
            durationSec: null,
        });
        files.set(value.mindPublicId, {
            publicId: value.mindPublicId,
            bytes: mindBytes.length,
            format: '',
            width: null,
            height: null,
            durationSec: null,
        });
        return { imagePublicId: value.imagePublicId, mindPublicId: value.mindPublicId };
    };
    it('requires a current admin, validates limits and signs separate isolated destinations', async () => {
        expect((await request(app).post(`${base}/upload-signature`).send({})).status).toBe(401);
        expect((await post('/upload-signature', {}, author)).status).toBe(403);
        expect((await post('/register', {}, author)).status).toBe(403);
        expect(
            (await post('/upload-signature', { imageFormat: 'svg', imageBytes: 1, mindBytes: 1 }))
                .status,
        ).toBe(400);
        const pair = await prepare();
        expect(pair.imagePublicId).toMatch(new RegExp(`^bookaria/markers/uploads/${owner}/`));
        expect(pair.mindPublicId).toBe(pair.imagePublicId.replace('/image', '/target.mind'));
        expect(signed.at(-2)).toMatchObject({ resourceType: 'image', allowedFormats: ['png'] });
        expect(signed.at(-1)).toMatchObject({ resourceType: 'raw', allowedFormats: [] });
    });
    it('allocates identifiers, defaults to inactive, and replays an uncertain registration exactly once', async () => {
        const pair = await prepare();
        const [a, b] = await Promise.all([post('/register', pair), post('/register', pair)]);
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        expect(a.body.data.id).toBe(b.body.data.id);
        expect(a.body.data).toMatchObject({ isActive: false, markerScore: null });
        expect(a.body.data.number).toBeGreaterThan(0);
        const audit = await pool.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE target_id=$1 AND action='MANAGE_MARKER'",
            [a.body.data.id],
        );
        expect(audit.rows[0].n).toBe(1);
        const again = await post('/register', { ...pair, isActive: true });
        expect(again.body.data.isActive).toBe(false);
        const other = await post('/register', { ...(await prepare()), isActive: true });
        expect(other.status).toBe(201);
        expect(other.body.data.isActive).toBe(true);
        expect(other.body.data.number).not.toBe(a.body.data.number);
    });
    it('rejects foreign/mismatched pairs, missing files, invalid shape and malformed or multi-target data', async () => {
        const pair = await prepare();
        expect(
            (
                await post('/register', {
                    ...pair,
                    imagePublicId: pair.imagePublicId.replace(
                        owner,
                        '11111111-1111-4111-8111-111111111111',
                    ),
                })
            ).status,
        ).toBe(400);
        expect(
            (await post('/register', { ...pair, mindPublicId: (await prepare()).mindPublicId }))
                .status,
        ).toBe(400);
        const metadata = files.get(pair.imagePublicId) as StoredFile;
        files.delete(pair.imagePublicId);
        expect((await post('/register', pair)).status).toBe(400);
        files.set(pair.imagePublicId, { ...metadata, height: 500 });
        expect((await post('/register', pair)).status).toBe(400);
        files.set(pair.imagePublicId, metadata);
        vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([1])));
        expect((await post('/register', pair)).status).toBe(400);
        vi.mocked(fetch).mockResolvedValueOnce(new Response(encode({ v: 2, dataList: [{}, {}] })));
        expect((await post('/register', pair)).status).toBe(400);
        expect(
            (
                await pool.query(
                    'SELECT count(*)::int AS n FROM bookaria_markers WHERE image_public_id=$1',
                    [pair.imagePublicId],
                )
            ).rows[0].n,
        ).toBe(0);
    });
});
