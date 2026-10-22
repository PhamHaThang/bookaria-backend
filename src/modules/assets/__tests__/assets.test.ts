import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { type MediaStorage, type StoredFile, setMediaStorage } from '../../../lib';
import { toAssetRef } from '../assets.service';
import type { AssetRow } from '../assets.types';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;

const PASSWORD = 'Matkhau-123';
const app = createApp();

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// --- Kho lưu trữ giả: không gọi Cloudinary thật -------------------------------------------------
const files = new Map<string, StoredFile>();
const destroyed: string[] = [];

const fakeStorage: MediaStorage = {
    signUpload: ({ publicId, resourceType, assetFolder }) => ({
        uploadUrl: `https://fake.test/${resourceType}/upload`,
        fields: {
            public_id: publicId,
            ...(assetFolder ? { asset_folder: assetFolder } : {}),
            timestamp: 1,
            signature: 'sig',
            api_key: 'key',
        },
        expiresAt: new Date(Date.now() + 50 * 60_000),
    }),
    inspect: async (_type, publicId) => files.get(publicId) ?? null,
    destroy: async (_type, publicId) => {
        files.delete(publicId);
        destroyed.push(publicId);
    },
    deliveryUrl: ({ resourceType, publicId, transform, format }) =>
        `https://fake.test/${resourceType}/upload/${transform ? `${transform}/` : ''}${publicId}${
            format ? `.${format}` : ''
        }`,
};

async function signUp() {
    const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: `a${unique()}@example.com`, password: PASSWORD, displayName: 'An' });
    return { token: res.body.data.accessToken as string, userId: res.body.data.user.id as string };
}

const signature = (token: string, body: Record<string, unknown> = {}) =>
    request(app)
        .post('/api/v1/assets/upload-signature')
        .set(auth(token))
        .send({
            purpose: 'ASSET',
            fileName: 'tranh.png',
            mimeType: 'image/png',
            sizeBytes: 1000,
            ...body,
        });

/** Xin chữ ký, "upload" bằng cách đặt file vào kho giả, rồi gọi complete. */
async function upload(
    token: string,
    opts: {
        sign?: Record<string, unknown>;
        stored?: Partial<StoredFile>;
        complete?: Record<string, unknown>;
        skipUpload?: boolean;
    } = {},
) {
    const sig = await signature(token, opts.sign);
    expect(sig.status).toBe(200);
    const assetId = sig.body.data.assetId as string;
    const publicId = sig.body.data.fields.public_id as string;
    if (!opts.skipUpload) {
        files.set(publicId, {
            publicId,
            bytes: 1000,
            format: 'png',
            width: 640,
            height: 480,
            durationSec: null,
            ...opts.stored,
        });
    }
    const res = await request(app)
        .post(`/api/v1/assets/${assetId}/complete`)
        .set(auth(token))
        .send(opts.complete ?? {});
    return { res, assetId, publicId };
}

suite('assets (tích hợp)', () => {
    beforeAll(() => setMediaStorage(fakeStorage));
    afterAll(() => setMediaStorage(undefined));
    beforeEach(() => {
        files.clear();
        destroyed.length = 0;
    });

    describe('POST /assets/upload-signature', () => {
        it('không có token -> 401', async () => {
            const res = await request(app).post('/api/v1/assets/upload-signature').send({});
            expect(res.status).toBe(401);
        });

        it('cấp chữ ký: public_id đúng dạng, không kết thúc bằng "/", ghi lại intent có hạn', async () => {
            const { token, userId } = await signUp();
            const res = await signature(token);
            expect(res.status).toBe(200);

            const { assetId, fields, uploadUrl, expiresAt } = res.body.data;
            expect(fields.public_id).toBe(`bookaria/${userId}/${assetId}`);
            expect(fields.asset_folder).toBe(`bookaria/${userId}`);
            expect(uploadUrl).toBe('https://fake.test/image/upload');
            expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

            const { rows } = await pool.query(
                'SELECT user_id, purpose, size_bytes, expires_at, completed_at FROM upload_intents WHERE asset_id = $1',
                [assetId],
            );
            expect(rows[0]).toMatchObject({ user_id: userId, purpose: 'ASSET' });
            expect(rows[0].expires_at).toBeInstanceOf(Date);
            expect(rows[0].completed_at).toBeNull();
        });

        it('loại file không hỗ trợ -> 422 FILE_TYPE_NOT_ALLOWED', async () => {
            const { token } = await signUp();
            const res = await signature(token, { fileName: 'a.exe', mimeType: 'application/zip' });
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
        });

        it('file quá lớn -> 413 FILE_TOO_LARGE kèm maxBytes', async () => {
            const { token } = await signUp();
            const res = await signature(token, { sizeBytes: 11 * 1024 * 1024 });
            expect(res.status).toBe(413);
            expect(res.body.error.code).toBe('FILE_TOO_LARGE');
            expect(res.body.error.details.maxBytes).toBe(10 * 1024 * 1024);
        });

        it('vượt hạn mức dung lượng -> 422 QUOTA_EXCEEDED', async () => {
            const { token, userId } = await signUp();
            await pool.query('UPDATE users SET storage_quota_bytes = 500 WHERE id = $1', [userId]);
            const res = await signature(token, { sizeBytes: 1000 });
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
        });

        it('thiếu trường -> 400 VALIDATION_ERROR', async () => {
            const { token } = await signUp();
            const res = await request(app)
                .post('/api/v1/assets/upload-signature')
                .set(auth(token))
                .send({ purpose: 'ASSET' });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('POST /assets/:assetId/complete', () => {
        it('audio Cloudinary width/height=0: stores no dimensions and detail/list remain readable', async () => {
            const { token } = await signUp();
            const { res, assetId } = await upload(token, {
                sign: { fileName: 'tone.wav', mimeType: 'audio/wav', sizeBytes: 8044 },
                stored: { format: 'wav', bytes: 8044, width: 0, height: 0, durationSec: 0.5 },
            });
            expect(res.status).toBe(202);
            const stored = await pool.query('SELECT meta FROM assets WHERE id = $1', [assetId]);
            expect(stored.rows[0].meta).toEqual({ purpose: 'ASSET', durationSec: 0.5 });
            const detail = await request(app).get(`/api/v1/assets/${assetId}`).set(auth(token));
            expect(detail.status).toBe(200);
            expect(detail.body.data.meta).toEqual(stored.rows[0].meta);
            const list = await request(app).get('/api/v1/assets?scope=mine').set(auth(token));
            expect(list.status).toBe(200);
            expect(list.body.data).toHaveLength(1);
            expect(list.body.data[0].id).toBe(assetId);
        });

        it.each(['READY', 'FAILED'])(
            'legacy %s audio with zero dimensions remains readable',
            async (status) => {
                const { token } = await signUp();
                const { assetId } = await upload(token, {
                    sign: { fileName: 'tone.wav', mimeType: 'audio/wav' },
                    stored: { format: 'wav', width: null, height: null, durationSec: 0.5 },
                });
                await pool.query(`UPDATE assets SET status = $2, meta = $3::jsonb WHERE id = $1`, [
                    assetId,
                    status,
                    JSON.stringify({ width: 0, height: 0, durationSec: 0.5, purpose: 'ASSET' }),
                ]);
                const detail = await request(app).get(`/api/v1/assets/${assetId}`).set(auth(token));
                expect(detail.status).toBe(200);
                expect(detail.body.data).toMatchObject({
                    status,
                    meta: { durationSec: 0.5, purpose: 'ASSET' },
                });
                expect(detail.body.data.meta).not.toHaveProperty('width');
                expect(detail.body.data.meta).not.toHaveProperty('height');
                const list = await request(app).get('/api/v1/assets?scope=mine').set(auth(token));
                expect(list.status).toBe(200);
                expect(list.body.data[0].meta).toEqual(detail.body.data.meta);
                const patch = await request(app)
                    .patch(`/api/v1/assets/${assetId}`)
                    .set(auth(token))
                    .send({ name: 'Audio cũ' });
                expect(patch.status).toBe(200);
                const row = await pool.query<AssetRow>('SELECT * FROM assets WHERE id = $1', [
                    assetId,
                ]);
                expect(toAssetRef(row.rows[0] as AssetRow).meta).toEqual(detail.body.data.meta);
            },
        );

        it('ảnh hợp lệ: 200, READY, tính dung lượng thật, có thumbnail', async () => {
            const { token, userId } = await signUp();
            const { res, assetId } = await upload(token, { stored: { bytes: 2345 } });

            expect(res.status).toBe(200);
            expect(res.body.data.asset).toMatchObject({
                id: assetId,
                type: 'IMAGE',
                status: 'READY',
                sizeBytes: 2345,
                format: 'png',
                name: 'tranh',
                scope: 'mine',
            });
            expect(res.body.data.asset.thumbnailUrl).toContain('c_fill');
            expect(res.body.data.asset.meta).toMatchObject({ width: 640, height: 480 });

            const { rows } = await pool.query(
                'SELECT storage_used_bytes::int AS used FROM users WHERE id = $1',
                [userId],
            );
            expect(rows[0].used).toBe(2345);
        });

        it('gọi complete hai lần: trả lại cùng tài nguyên, không tính dung lượng hai lần', async () => {
            const { token, userId } = await signUp();
            const first = await upload(token, { stored: { bytes: 700 } });
            const again = await request(app)
                .post(`/api/v1/assets/${first.assetId}/complete`)
                .set(auth(token))
                .send({});
            expect(again.status).toBe(200);
            expect(again.body.data.asset.id).toBe(first.assetId);

            const { rows } = await pool.query(
                'SELECT storage_used_bytes::int AS used FROM users WHERE id = $1',
                [userId],
            );
            expect(rows[0].used).toBe(700);
        });

        it('file chưa được upload -> 404', async () => {
            const { token } = await signUp();
            const { res } = await upload(token, { skipUpload: true });
            expect(res.status).toBe(404);
        });

        it('định dạng thật không đúng (gif) -> 422 và file bị xoá khỏi kho', async () => {
            const { token } = await signUp();
            const { res, publicId } = await upload(token, { stored: { format: 'gif' } });
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
            expect(destroyed).toContain(publicId);
        });

        it('dung lượng thật vượt hạn mức dù đã khai nhỏ -> 422 QUOTA_EXCEEDED, file bị xoá một lần', async () => {
            const { token, userId } = await signUp();
            await pool.query('UPDATE users SET storage_quota_bytes = 5000 WHERE id = $1', [userId]);
            const { res, publicId } = await upload(token, {
                sign: { sizeBytes: 1000 },
                stored: { bytes: 9000 },
            });
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
            expect(destroyed.filter((p) => p === publicId)).toHaveLength(1);
        });

        it('model / audio: 202 PROCESSING kèm jobId, có dòng job trong DB', async () => {
            const { token } = await signUp();
            const { res, assetId } = await upload(token, {
                sign: {
                    fileName: 'nhac.mp3',
                    mimeType: 'audio/mpeg',
                    sizeBytes: 5000,
                },
                stored: { format: 'mp3', bytes: 5000, width: null, height: null, durationSec: 12 },
            });
            expect(res.status).toBe(202);
            expect(res.body.data.asset).toMatchObject({
                id: assetId,
                type: 'AUDIO',
                status: 'PROCESSING',
            });

            const { rows } = await pool.query(
                `SELECT type, status FROM jobs WHERE id = $1 AND ref_id = $2`,
                [res.body.data.jobId, assetId],
            );
            expect(rows[0]).toEqual({ type: 'OPTIMIZE_ASSET', status: 'QUEUED' });
        });

        it('tên và thẻ do người dùng đặt: thẻ chuyển chữ thường và bỏ trùng', async () => {
            const { token } = await signUp();
            const { res } = await upload(token, {
                complete: { name: 'Con mèo', tags: ['Mèo', 'mèo', 'Dễ thương'] },
            });
            expect(res.status).toBe(200);
            expect(res.body.data.asset.name).toBe('Con mèo');
            expect(res.body.data.asset.tags).toEqual(['mèo', 'dễ thương']);
        });

        it('assetId của người khác hoặc không tồn tại -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const { assetId } = await upload(a.token, { skipUpload: true });
            const other = await request(app)
                .post(`/api/v1/assets/${assetId}/complete`)
                .set(auth(b.token))
                .send({});
            expect(other.status).toBe(404);

            const unknown = await request(app)
                .post('/api/v1/assets/khong-phai-uuid/complete')
                .set(auth(a.token))
                .send({});
            expect(unknown.status).toBe(404);
        });

        it('mục đích MARKER_MIND không phải tài nguyên -> 422', async () => {
            const { token } = await signUp();
            const { res } = await upload(token, {
                sign: {
                    purpose: 'MARKER_MIND',
                    fileName: 'a.mind',
                    mimeType: 'application/octet-stream',
                },
                stored: { format: '' },
            });
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
        });
    });

    describe('GET /assets, GET /assets/:assetId', () => {
        it('chỉ liệt kê tài nguyên của mình, phân trang có total là số', async () => {
            const a = await signUp();
            const b = await signUp();
            for (let i = 0; i < 3; i++) await upload(a.token);
            await upload(b.token);

            const res = await request(app).get('/api/v1/assets?limit=2').set(auth(a.token));
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(2);
            expect(res.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
        });

        it('lọc theo loại và tìm theo tên (ký tự % là chữ thường)', async () => {
            const { token } = await signUp();
            await upload(token, { complete: { name: 'Giảm 50% giá' } });
            await upload(token, { complete: { name: 'Con cá' } });

            const found = await request(app).get('/api/v1/assets?q=%25').set(auth(token));
            expect(found.body.data.map((a: { name: string }) => a.name)).toEqual(['Giảm 50% giá']);

            const audio = await request(app).get('/api/v1/assets?type=AUDIO').set(auth(token));
            expect(audio.body.meta.total).toBe(0);
        });

        it('ảnh đại diện không lẫn vào thư viện của tôi', async () => {
            const { token } = await signUp();
            await upload(token, {
                sign: { purpose: 'AVATAR', fileName: 'toi.jpg', mimeType: 'image/jpeg' },
                stored: { format: 'jpg' },
            });
            const res = await request(app).get('/api/v1/assets').set(auth(token));
            expect(res.body.meta.total).toBe(0);
        });

        it('thư viện chung: thấy tài nguyên đã sẵn sàng, không sửa/xoá được', async () => {
            const { token } = await signUp();
            const name = `Thư viện ${unique()}`;
            const { rows } = await pool.query(
                `INSERT INTO assets (owner_id, type, name, original_public_id, resource_type, format, size_bytes, status, license, author_name)
                 VALUES (NULL, 'IMAGE', $1, $2, 'image', 'png', 100, 'READY', 'CC0', 'Ai đó')
                 RETURNING id`,
                [name, `lib/${unique()}`],
            );
            const id = rows[0].id as string;

            const list = await request(app)
                .get(`/api/v1/assets?scope=library&q=${encodeURIComponent(name)}`)
                .set(auth(token));
            expect(list.body.data.map((a: { id: string }) => a.id)).toEqual([id]);
            expect(list.body.data[0].scope).toBe('library');

            const get = await request(app).get(`/api/v1/assets/${id}`).set(auth(token));
            expect(get.status).toBe(200);
            const patch = await request(app)
                .patch(`/api/v1/assets/${id}`)
                .set(auth(token))
                .send({ name: 'x' });
            expect(patch.status).toBe(404);
            const del = await request(app).delete(`/api/v1/assets/${id}`).set(auth(token));
            expect(del.status).toBe(404);
        });

        it('tài nguyên của người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const { assetId } = await upload(a.token);
            const res = await request(app).get(`/api/v1/assets/${assetId}`).set(auth(b.token));
            expect(res.status).toBe(404);
        });
    });

    describe('PATCH /assets/:assetId', () => {
        it('đổi tên và thẻ; body rỗng -> 400', async () => {
            const { token } = await signUp();
            const { assetId } = await upload(token);

            const ok = await request(app)
                .patch(`/api/v1/assets/${assetId}`)
                .set(auth(token))
                .send({ name: 'Tên mới', tags: ['A', 'a', 'B'] });
            expect(ok.status).toBe(200);
            expect(ok.body.data).toMatchObject({ name: 'Tên mới', tags: ['a', 'b'] });

            const empty = await request(app)
                .patch(`/api/v1/assets/${assetId}`)
                .set(auth(token))
                .send({});
            expect(empty.status).toBe(400);
        });
    });

    describe('DELETE /assets/:assetId', () => {
        it('xoá mềm: biến khỏi danh sách và trả lại dung lượng', async () => {
            const { token, userId } = await signUp();
            const { assetId } = await upload(token, { stored: { bytes: 4000 } });

            const del = await request(app).delete(`/api/v1/assets/${assetId}`).set(auth(token));
            expect(del.status).toBe(204);

            const list = await request(app).get('/api/v1/assets').set(auth(token));
            expect(list.body.meta.total).toBe(0);
            const { rows } = await pool.query(
                'SELECT storage_used_bytes::int AS used FROM users WHERE id = $1',
                [userId],
            );
            expect(rows[0].used).toBe(0);
        });

        it('đang được dùng trong trang -> 409 ASSET_IN_USE kèm nơi dùng', async () => {
            const { token } = await signUp();
            const book = await request(app)
                .post('/api/v1/books')
                .set(auth(token))
                .send({ title: 'Sách' });
            const bookId = book.body.data.book.id as string;
            const { assetId } = await upload(token, {
                sign: { purpose: 'PAGE_IMAGE' },
            });
            await pool.query(
                `INSERT INTO pages (book_id, order_index, image_asset_id, marker_mode, marker_mind_public_id)
                 VALUES ($1, 0, $2, 'CUSTOM_MARKER', 'bookaria/test.mind')`,
                [bookId, assetId],
            );

            const res = await request(app).delete(`/api/v1/assets/${assetId}`).set(auth(token));
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('ASSET_IN_USE');
            expect(res.body.error.details.usages[0]).toMatchObject({ bookId, pageNumber: 1 });

            const usages = await request(app)
                .get(`/api/v1/assets/${assetId}/usages`)
                .set(auth(token));
            expect(usages.status).toBe(200);
            expect(usages.body.data).toHaveLength(1);
        });
    });

    describe('ảnh bìa sách', () => {
        it('đặt ảnh của mình làm bìa -> coverUrl; xoá ảnh thì bìa bị gỡ', async () => {
            const { token } = await signUp();
            const book = await request(app)
                .post('/api/v1/books')
                .set(auth(token))
                .send({ title: 'Sách' });
            const bookId = book.body.data.book.id as string;
            const { assetId } = await upload(token);

            const set = await request(app)
                .patch(`/api/v1/books/${bookId}`)
                .set(auth(token))
                .send({ coverAssetId: assetId });
            expect(set.status).toBe(200);
            expect(set.body.data.coverUrl).toContain('fake.test');

            await request(app).delete(`/api/v1/assets/${assetId}`).set(auth(token));
            const after = await request(app).get(`/api/v1/books/${bookId}`).set(auth(token));
            expect(after.body.data.coverUrl).toBeNull();
        });

        it('ảnh của người khác -> 400 gắn vào coverAssetId', async () => {
            const a = await signUp();
            const b = await signUp();
            const book = await request(app)
                .post('/api/v1/books')
                .set(auth(a.token))
                .send({ title: 'Sách' });
            const { assetId } = await upload(b.token);

            const res = await request(app)
                .patch(`/api/v1/books/${book.body.data.book.id}`)
                .set(auth(a.token))
                .send({ coverAssetId: assetId });
            expect(res.status).toBe(400);
            expect(res.body.error.details[0].path).toBe('coverAssetId');
        });
    });

    describe('ảnh đại diện', () => {
        it('đặt ảnh đại diện từ tài nguyên mục đích AVATAR; xoá tài nguyên thì ảnh bị gỡ', async () => {
            const { token } = await signUp();
            const { assetId } = await upload(token, {
                sign: { purpose: 'AVATAR', fileName: 'toi.jpg', mimeType: 'image/jpeg' },
                stored: { format: 'jpg' },
            });

            const set = await request(app)
                .patch('/api/v1/me')
                .set(auth(token))
                .send({ avatarAssetId: assetId });
            expect(set.status).toBe(200);
            expect(set.body.data.avatarUrl).toContain('c_fill,g_face');

            await request(app).delete(`/api/v1/assets/${assetId}`).set(auth(token));
            const me = await request(app).get('/api/v1/me').set(auth(token));
            expect(me.body.data.avatarUrl).toBeNull();
        });

        it('ảnh thường (không phải AVATAR) -> 400 gắn vào avatarAssetId', async () => {
            const { token } = await signUp();
            const { assetId } = await upload(token);
            const res = await request(app)
                .patch('/api/v1/me')
                .set(auth(token))
                .send({ avatarAssetId: assetId });
            expect(res.status).toBe(400);
            expect(res.body.error.details[0].path).toBe('avatarAssetId');
        });
    });

    describe('GET /asset-categories', () => {
        it('trả danh sách (có thể rỗng)', async () => {
            const { token } = await signUp();
            const res = await request(app).get('/api/v1/asset-categories').set(auth(token));
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
        });
    });
});
