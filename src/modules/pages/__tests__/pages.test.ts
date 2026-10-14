import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { type MediaStorage, setMediaStorage } from '../../../lib';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;

const PASSWORD = 'Matkhau-123';
const app = createApp();

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Kho giả: chỉ cần dựng URL và "thấy" các file .mind do test đặt vào. */
const rawFiles = new Map<string, number>();
const fakeStorage: MediaStorage = {
    signUpload: () => {
        throw new Error('không dùng trong test này');
    },
    inspect: async (_type, publicId) => {
        const bytes = rawFiles.get(publicId);
        return bytes === undefined
            ? null
            : { publicId, bytes, format: '', width: null, height: null, durationSec: null };
    },
    destroy: async () => {},
    deliveryUrl: ({ resourceType, publicId, transform }) =>
        `https://fake.test/${resourceType}/upload/${transform ? `${transform}/` : ''}${publicId}`,
};

async function signUp() {
    const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: `p${unique()}@example.com`, password: PASSWORD, displayName: 'An' });
    return { token: res.body.data.accessToken as string, userId: res.body.data.user.id as string };
}

async function createBook(token: string) {
    const res = await request(app).post('/api/v1/books').set(auth(token)).send({ title: 'Sách' });
    return res.body.data.book.id as string;
}

/** Tạo thẳng một tài nguyên đã sẵn sàng trong DB (không cần qua luồng upload). */
async function createAsset(userId: string, type: 'IMAGE' | 'AUDIO' = 'IMAGE') {
    const { rows } = await pool.query(
        `INSERT INTO assets (owner_id, type, name, original_public_id, resource_type, format, size_bytes, status, meta)
         VALUES ($1, $2, 'tranh', $3, $4, $5, 100, 'READY', '{"width":640,"height":480}')
         RETURNING id`,
        [
            userId,
            type,
            `bookaria/${userId}/${unique()}`,
            type === 'AUDIO' ? 'video' : 'image',
            type === 'AUDIO' ? 'mp3' : 'png',
        ],
    );
    return rows[0].id as string;
}

async function addPage(
    token: string,
    bookId: string,
    body: Record<string, unknown>,
): Promise<request.Response> {
    return request(app).post(`/api/v1/books/${bookId}/pages`).set(auth(token)).send(body);
}

async function listPages(token: string, bookId: string) {
    const res = await request(app).get(`/api/v1/books/${bookId}/pages`).set(auth(token));
    return res.body.data as { id: string; orderIndex: number; markerMode: string }[];
}

/** Bảo đảm có sẵn vài marker Bookaria dùng được. */
async function ensureMarkers(count = 5) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM bookaria_markers WHERE validated_at IS NOT NULL AND is_active`,
    );
    for (let i = rows[0].n as number; i < count; i++) {
        const n = 900_000 + Math.floor(Math.random() * 90_000_000);
        await pool.query(
            `INSERT INTO bookaria_markers (number, image_public_id, seed, mind_public_id, validated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT DO NOTHING`,
            [n, `m/${n}`, n, `m/${n}.mind`],
        );
    }
}

suite('pages (tích hợp)', () => {
    beforeAll(async () => {
        setMediaStorage(fakeStorage);
        await ensureMarkers();
    });
    afterAll(() => setMediaStorage(undefined));

    describe('POST /books/:bookId/pages', () => {
        it('không có token -> 401', async () => {
            const res = await request(app).get('/api/v1/books/x/pages');
            expect(res.status).toBe(401);
        });

        it('thêm trang cuối: 201, có số marker Bookaria, sách đếm đủ trang', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const imageAssetId = await createAsset(userId);

            const res = await addPage(token, bookId, { imageAssetId, title: 'Trang 1' });
            expect(res.status).toBe(201);
            expect(res.body.data.page).toMatchObject({
                orderIndex: 0,
                markerMode: 'BOOKARIA_MARKER',
                markerNumber: expect.any(Number),
            });
            expect(res.body.data.page.id).toEqual(expect.any(String));

            const book = await request(app).get(`/api/v1/books/${bookId}`).set(auth(token));
            expect(book.body.data.pageCount).toBe(1);
            expect(book.body.data.pages).toHaveLength(1);
        });

        it('chèn đầu và chèn sau một trang: thứ tự và số thứ tự liền nhau', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);

            const a = (await addPage(token, bookId, { imageAssetId: img, title: 'A' })).body.data
                .page.id;
            const b = (await addPage(token, bookId, { imageAssetId: img, title: 'B' })).body.data
                .page.id;
            const first = (
                await addPage(token, bookId, { imageAssetId: img, title: 'Đầu', afterPageId: null })
            ).body.data.page.id;
            const mid = (
                await addPage(token, bookId, { imageAssetId: img, title: 'Giữa', afterPageId: a })
            ).body.data.page.id;

            const pages = await listPages(token, bookId);
            expect(pages.map((p) => p.id)).toEqual([first, a, mid, b]);
            expect(pages.map((p) => p.orderIndex)).toEqual([0, 1, 2, 3]);
        });

        it('mỗi trang trong một sách có số marker khác nhau', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const numbers = new Set<number>();
            for (let i = 0; i < 3; i++) {
                const r = await addPage(token, bookId, { imageAssetId: img });
                numbers.add(r.body.data.page.markerNumber);
            }
            expect(numbers.size).toBe(3);
        });

        it('ảnh của người khác -> 404; tài nguyên không phải ảnh -> 400', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookId = await createBook(a.token);
            const otherImage = await createAsset(b.userId);
            const audio = await createAsset(a.userId, 'AUDIO');

            const other = await addPage(a.token, bookId, { imageAssetId: otherImage });
            expect(other.status).toBe(404);

            const notImage = await addPage(a.token, bookId, { imageAssetId: audio });
            expect(notImage.status).toBe(400);
            expect(notImage.body.error.details[0].path).toBe('imageAssetId');
        });

        it('afterPageId không thuộc sách -> 404; sách người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookA = await createBook(a.token);
            const bookB = await createBook(b.token);
            const imgA = await createAsset(a.userId);
            const imgB = await createAsset(b.userId);
            const pageB = (await addPage(b.token, bookB, { imageAssetId: imgB })).body.data.page.id;

            const wrongAfter = await addPage(a.token, bookA, {
                imageAssetId: imgA,
                afterPageId: pageB,
            });
            expect(wrongAfter.status).toBe(404);

            const foreignBook = await addPage(a.token, bookB, { imageAssetId: imgA });
            expect(foreignBook.status).toBe(404);
        });

        it('sách đang xuất bản (có tác vụ BOOK đang chạy) -> 409 JOB_IN_PROGRESS', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            await pool.query(
                `INSERT INTO jobs (type, status, ref_type, ref_id, created_by)
                 VALUES ('PUBLISH_BOOK', 'RUNNING', 'BOOK', $1, $2)`,
                [bookId, userId],
            );
            const res = await addPage(token, bookId, { imageAssetId: img });
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('JOB_IN_PROGRESS');
        });

        it('hết marker Bookaria: vẫn tạo trang (không AR) kèm cảnh báo', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE bookaria_markers SET is_active = false');
                await client.query('COMMIT');
                const res = await addPage(token, bookId, { imageAssetId: img });
                expect(res.status).toBe(201);
                expect(res.body.data.page).toMatchObject({
                    markerMode: 'NONE',
                    markerNumber: null,
                });
                expect(res.body.data.warnings).toEqual(['NO_MARKER_AVAILABLE']);
            } finally {
                await client.query('UPDATE bookaria_markers SET is_active = true');
                client.release();
            }
        });
    });

    describe('GET /books/:bookId/pages, GET /pages/:pageId', () => {
        it('liệt kê theo thứ tự; sách người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookId = await createBook(a.token);
            const img = await createAsset(a.userId);
            await addPage(a.token, bookId, { imageAssetId: img, title: 'Một' });
            await addPage(a.token, bookId, { imageAssetId: img, title: 'Hai' });

            const res = await request(app).get(`/api/v1/books/${bookId}/pages`).set(auth(a.token));
            expect(res.status).toBe(200);
            expect(res.body.data.map((p: { title: string }) => p.title)).toEqual(['Một', 'Hai']);
            expect(res.body.data[0].thumbnailUrl).toContain('fake.test');

            const other = await request(app)
                .get(`/api/v1/books/${bookId}/pages`)
                .set(auth(b.token));
            expect(other.status).toBe(404);
        });

        it('chi tiết trang: ảnh, cảnh, cài đặt, marker; người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookId = await createBook(a.token);
            const img = await createAsset(a.userId);
            const pageId = (await addPage(a.token, bookId, { imageAssetId: img })).body.data.page
                .id;

            const res = await request(app).get(`/api/v1/pages/${pageId}`).set(auth(a.token));
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                id: pageId,
                bookId,
                revision: 0,
                markerMode: 'BOOKARIA_MARKER',
                image: { width: 640, height: 480 },
            });
            expect(res.body.data.scene).toBeTruthy();
            expect(res.body.data.bookariaMarker.number).toEqual(expect.any(Number));

            const other = await request(app).get(`/api/v1/pages/${pageId}`).set(auth(b.token));
            expect(other.status).toBe(404);
            const bad = await request(app).get('/api/v1/pages/khong-phai-uuid').set(auth(a.token));
            expect(bad.status).toBe(404);
        });
    });

    describe('PATCH /books/:bookId/pages/reorder', () => {
        it('đổi thứ tự đúng và đủ', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const ids: string[] = [];
            for (let i = 0; i < 3; i++) {
                ids.push((await addPage(token, bookId, { imageAssetId: img })).body.data.page.id);
            }
            const next = [ids[2], ids[0], ids[1]];

            const res = await request(app)
                .patch(`/api/v1/books/${bookId}/pages/reorder`)
                .set(auth(token))
                .send({ pageIds: next });
            expect(res.status).toBe(200);
            expect((await listPages(token, bookId)).map((p) => p.id)).toEqual(next);
        });

        it('thiếu trang hoặc có trang lạ -> 400 gắn vào pageIds', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const a = (await addPage(token, bookId, { imageAssetId: img })).body.data.page.id;
            await addPage(token, bookId, { imageAssetId: img });

            const res = await request(app)
                .patch(`/api/v1/books/${bookId}/pages/reorder`)
                .set(auth(token))
                .send({ pageIds: [a] });
            expect(res.status).toBe(400);
            expect(res.body.error.details[0].path).toBe('pageIds');
        });
    });

    describe('PATCH /pages/:pageId', () => {
        it('đổi tên (chuỗi rỗng thành null) và không đụng revision của cảnh', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const pageId = (await addPage(token, bookId, { imageAssetId: img, title: 'Cũ' })).body
                .data.page.id;

            const renamed = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(token))
                .send({ title: 'Mới' });
            expect(renamed.status).toBe(200);
            expect(renamed.body.data).toMatchObject({ title: 'Mới', revision: 0 });

            const cleared = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(token))
                .send({ title: '' });
            expect(cleared.body.data.title).toBeNull();
        });

        it('noAr: tắt AR thì trả marker, bật lại thì cấp marker mới', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const pageId = (await addPage(token, bookId, { imageAssetId: img })).body.data.page.id;

            const off = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(token))
                .send({ noAr: true });
            expect(off.body.data).toMatchObject({ markerMode: 'NONE', markerNumber: null });

            const on = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(token))
                .send({ noAr: false });
            expect(on.body.data.markerMode).toBe('BOOKARIA_MARKER');
            expect(on.body.data.markerNumber).toEqual(expect.any(Number));
        });

        it('cài đặt: âm thanh phải là audio của mình, sai thì 400 gắn vào settings.*', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const audio = await createAsset(userId, 'AUDIO');
            const pageId = (await addPage(token, bookId, { imageAssetId: img })).body.data.page.id;

            const ok = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(token))
                .send({ settings: { backgroundAudioAssetId: audio } });
            expect(ok.status).toBe(200);
            expect(ok.body.data.settings.backgroundAudioAssetId).toBe(audio);

            const bad = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(token))
                .send({ settings: { backgroundAudioAssetId: img } });
            expect(bad.status).toBe(400);
            expect(bad.body.error.details[0].path).toBe('settings.backgroundAudioAssetId');
        });

        it('body rỗng -> 400; trang người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookId = await createBook(a.token);
            const img = await createAsset(a.userId);
            const pageId = (await addPage(a.token, bookId, { imageAssetId: img })).body.data.page
                .id;

            const empty = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(a.token))
                .send({});
            expect(empty.status).toBe(400);
            const other = await request(app)
                .patch(`/api/v1/pages/${pageId}`)
                .set(auth(b.token))
                .send({ title: 'x' });
            expect(other.status).toBe(404);
        });
    });

    describe('PUT /pages/:pageId/image', () => {
        it('trang marker Bookaria: đổi ảnh được, không cần file .mind', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const first = await createAsset(userId);
            const second = await createAsset(userId);
            const pageId = (await addPage(token, bookId, { imageAssetId: first })).body.data.page
                .id;

            const res = await request(app)
                .put(`/api/v1/pages/${pageId}/image`)
                .set(auth(token))
                .send({ imageAssetId: second });
            expect(res.status).toBe(200);
            expect(res.body.data.page.id).toBe(pageId);
            expect(res.body.data.jobId).toBeUndefined();

            const { rows } = await pool.query('SELECT image_asset_id FROM pages WHERE id = $1', [
                pageId,
            ]);
            expect(rows[0].image_asset_id).toBe(second);
        });

        it('trang marker riêng: thiếu .mind -> 400; có .mind của mình -> 200 kèm jobId', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const first = await createAsset(userId);
            const second = await createAsset(userId);
            const pageId = (await addPage(token, bookId, { imageAssetId: first })).body.data.page
                .id;
            const mind = `bookaria/${userId}/${unique()}.mind`;
            await pool.query(
                `UPDATE pages SET marker_mode = 'CUSTOM_MARKER', bookaria_marker_id = NULL,
                 bookaria_marker_transform = NULL, marker_mind_public_id = $2 WHERE id = $1`,
                [pageId, `bookaria/${userId}/cu.mind`],
            );

            const missing = await request(app)
                .put(`/api/v1/pages/${pageId}/image`)
                .set(auth(token))
                .send({ imageAssetId: second });
            expect(missing.status).toBe(400);
            expect(missing.body.error.details[0].path).toBe('markerMindPublicId');

            // File .mind chưa có trên kho -> từ chối.
            const notThere = await request(app)
                .put(`/api/v1/pages/${pageId}/image`)
                .set(auth(token))
                .send({ imageAssetId: second, markerMindPublicId: mind });
            expect(notThere.status).toBe(400);

            // File của người khác (sai thư mục) -> từ chối dù có trên kho.
            const foreign = `bookaria/${'0'.repeat(8)}-0000-0000-0000-000000000000/${unique()}.mind`;
            rawFiles.set(foreign, 1000);
            const foreignRes = await request(app)
                .put(`/api/v1/pages/${pageId}/image`)
                .set(auth(token))
                .send({ imageAssetId: second, markerMindPublicId: foreign });
            expect(foreignRes.status).toBe(400);

            rawFiles.set(mind, 1000);
            const ok = await request(app)
                .put(`/api/v1/pages/${pageId}/image`)
                .set(auth(token))
                .send({ imageAssetId: second, markerMindPublicId: mind });
            expect(ok.status).toBe(200);
            expect(ok.body.data.jobId).toEqual(expect.any(String));

            const { rows } = await pool.query(
                `SELECT type, status FROM jobs WHERE id = $1 AND ref_id = $2`,
                [ok.body.data.jobId, pageId],
            );
            expect(rows[0]).toEqual({ type: 'SCORE_MARKER', status: 'QUEUED' });
        });

        it('ảnh của người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookId = await createBook(a.token);
            const mine = await createAsset(a.userId);
            const theirs = await createAsset(b.userId);
            const pageId = (await addPage(a.token, bookId, { imageAssetId: mine })).body.data.page
                .id;
            const res = await request(app)
                .put(`/api/v1/pages/${pageId}/image`)
                .set(auth(a.token))
                .send({ imageAssetId: theirs });
            expect(res.status).toBe(404);
        });
    });

    describe('POST /pages/:pageId/duplicate', () => {
        it('bản sao nằm ngay sau bản gốc, giữ ảnh, có số marker riêng', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const a = (await addPage(token, bookId, { imageAssetId: img, title: 'A' })).body.data
                .page;
            const b = (await addPage(token, bookId, { imageAssetId: img, title: 'B' })).body.data
                .page;

            const res = await request(app).post(`/api/v1/pages/${a.id}/duplicate`).set(auth(token));
            expect(res.status).toBe(201);
            const copy = res.body.data.page;
            expect(copy).toMatchObject({
                title: 'A',
                orderIndex: 1,
                markerMode: 'BOOKARIA_MARKER',
            });
            expect(copy.id).not.toBe(a.id);
            expect(copy.markerNumber).not.toBe(a.markerNumber);

            const pages = await listPages(token, bookId);
            expect(pages.map((p) => p.id)).toEqual([a.id, copy.id, b.id]);
        });

        it('trang marker riêng: bản sao dùng marker Bookaria (chủ đích)', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const pageId = (await addPage(token, bookId, { imageAssetId: img })).body.data.page.id;
            await pool.query(
                `UPDATE pages SET marker_mode = 'CUSTOM_MARKER', bookaria_marker_id = NULL,
                 bookaria_marker_transform = NULL, marker_mind_public_id = $2 WHERE id = $1`,
                [pageId, `bookaria/${userId}/cu.mind`],
            );
            const res = await request(app)
                .post(`/api/v1/pages/${pageId}/duplicate`)
                .set(auth(token));
            expect(res.status).toBe(201);
            expect(res.body.data.page.markerMode).toBe('BOOKARIA_MARKER');
        });

        it('trang người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookId = await createBook(a.token);
            const img = await createAsset(a.userId);
            const pageId = (await addPage(a.token, bookId, { imageAssetId: img })).body.data.page
                .id;
            const res = await request(app)
                .post(`/api/v1/pages/${pageId}/duplicate`)
                .set(auth(b.token));
            expect(res.status).toBe(404);
        });
    });

    describe('DELETE /pages/:pageId', () => {
        it('xoá trang: các trang sau dồn lên, không còn khe hở', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const ids: string[] = [];
            for (let i = 0; i < 3; i++) {
                ids.push((await addPage(token, bookId, { imageAssetId: img })).body.data.page.id);
            }

            const res = await request(app).delete(`/api/v1/pages/${ids[1]}`).set(auth(token));
            expect(res.status).toBe(204);

            const pages = await listPages(token, bookId);
            expect(pages.map((p) => p.id)).toEqual([ids[0], ids[2]]);
            expect(pages.map((p) => p.orderIndex)).toEqual([0, 1]);
        });

        it('xoá được tài nguyên ảnh sau khi trang đã bị xoá (không còn bị giữ)', async () => {
            const { token, userId } = await signUp();
            const bookId = await createBook(token);
            const img = await createAsset(userId);
            const pageId = (await addPage(token, bookId, { imageAssetId: img })).body.data.page.id;

            const blocked = await request(app).delete(`/api/v1/assets/${img}`).set(auth(token));
            expect(blocked.status).toBe(409);
            expect(blocked.body.error.code).toBe('ASSET_IN_USE');

            await request(app).delete(`/api/v1/pages/${pageId}`).set(auth(token));
            const ok = await request(app).delete(`/api/v1/assets/${img}`).set(auth(token));
            expect(ok.status).toBe(204);
        });

        it('trang người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const bookId = await createBook(a.token);
            const img = await createAsset(a.userId);
            const pageId = (await addPage(a.token, bookId, { imageAssetId: img })).body.data.page
                .id;
            const res = await request(app).delete(`/api/v1/pages/${pageId}`).set(auth(b.token));
            expect(res.status).toBe(404);
        });
    });
});
