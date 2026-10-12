import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { PAGE_ASPECT } from '../books.constants';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;

const PASSWORD = 'Matkhau-123';
const app = createApp();

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function signUp() {
    const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: `b${unique()}@example.com`, password: PASSWORD, displayName: 'An' });
    return { token: res.body.data.accessToken as string, userId: res.body.data.user.id as string };
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createBook(token: string, body: Record<string, unknown> = {}) {
    const res = await request(app)
        .post('/api/v1/books')
        .set(auth(token))
        .send({ title: 'Truyện cổ tích', ...body });
    return res;
}

suite('books (tích hợp)', () => {
    describe('xác thực', () => {
        it('không có token -> 401', async () => {
            const res = await request(app).get('/api/v1/books');
            expect(res.status).toBe(401);
        });
    });

    describe('POST /books', () => {
        it('tạo sách trống: nháp, riêng tư, 0 trang, khổ A4 mặc định', async () => {
            const { token } = await signUp();
            const res = await createBook(token);
            expect(res.status).toBe(201);
            expect(res.body.data.book).toMatchObject({
                title: 'Truyện cổ tích',
                status: 'DRAFT',
                visibility: 'PRIVATE',
                pageCount: 0,
            });

            const { rows } = await pool.query(
                'SELECT page_format, page_aspect::float AS aspect, language FROM books WHERE id = $1',
                [res.body.data.book.id],
            );
            expect(rows[0]).toMatchObject({ page_format: 'A4', language: 'vi' });
            expect(rows[0].aspect).toBeCloseTo(PAGE_ASPECT.A4, 4);
        });

        it('khổ CUSTOM phải có pageAspect; có thì lưu đúng tỉ lệ', async () => {
            const { token } = await signUp();
            const missing = await createBook(token, { pageFormat: 'CUSTOM' });
            expect(missing.status).toBe(400);
            expect(missing.body.error.code).toBe('VALIDATION_ERROR');

            const ok = await createBook(token, { pageFormat: 'CUSTOM', pageAspect: 1.25 });
            expect(ok.status).toBe(201);
            const { rows } = await pool.query(
                'SELECT page_aspect::float AS aspect FROM books WHERE id = $1',
                [ok.body.data.book.id],
            );
            expect(rows[0].aspect).toBeCloseTo(1.25, 4);
        });

        it('dữ liệu sai -> 400 (tiêu đề rỗng, tuổi tối đa nhỏ hơn tối thiểu)', async () => {
            const { token } = await signUp();
            expect((await createBook(token, { title: '' })).status).toBe(400);
            expect((await createBook(token, { ageMin: 8, ageMax: 3 })).status).toBe(400);
        });

        it('tạo từ mẫu chưa hỗ trợ -> 400 gắn vào trường source', async () => {
            const { token } = await signUp();
            const res = await createBook(token, {
                source: { type: 'TEMPLATE', templateId: '3f2b1c4e-5a6d-4e8f-9a0b-1c2d3e4f5a6b' },
            });
            expect(res.status).toBe(400);
            expect(res.body.error.details[0].path).toBe('source');
        });
    });

    describe('GET /books', () => {
        it('phân trang, total là số, chỉ thấy sách của mình', async () => {
            const a = await signUp();
            const b = await signUp();
            for (let i = 0; i < 3; i++) await createBook(a.token, { title: `Sách ${i}` });
            await createBook(b.token, { title: 'Sách của người khác' });

            const res = await request(app).get('/api/v1/books?limit=2').set(auth(a.token));
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(2);
            expect(res.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
        });

        it('tìm theo tên: không phân biệt hoa thường, ký tự % và _ được coi là chữ thường', async () => {
            const { token } = await signUp();
            await createBook(token, { title: 'Chú Mèo Con' });
            await createBook(token, { title: 'Giảm 50% giá' });
            await createBook(token, { title: 'Cá voi' });

            const cat = await request(app).get('/api/v1/books?q=mèo').set(auth(token));
            expect(cat.body.data.map((b: { title: string }) => b.title)).toEqual(['Chú Mèo Con']);

            const percent = await request(app).get('/api/v1/books?q=%25').set(auth(token));
            expect(percent.body.data.map((b: { title: string }) => b.title)).toEqual([
                'Giảm 50% giá',
            ]);
        });

        it('sắp xếp theo tiêu đề tăng và giảm dần', async () => {
            const { token } = await signUp();
            for (const title of ['B', 'A', 'C']) await createBook(token, { title });

            const asc = await request(app).get('/api/v1/books?sort=title').set(auth(token));
            expect(asc.body.data.map((b: { title: string }) => b.title)).toEqual(['A', 'B', 'C']);
            const desc = await request(app).get('/api/v1/books?sort=-title').set(auth(token));
            expect(desc.body.data.map((b: { title: string }) => b.title)).toEqual(['C', 'B', 'A']);
        });

        it('sort sai -> 400, status sai -> 400', async () => {
            const { token } = await signUp();
            expect((await request(app).get('/api/v1/books?sort=id').set(auth(token))).status).toBe(
                400,
            );
            expect(
                (await request(app).get('/api/v1/books?status=XYZ').set(auth(token))).status,
            ).toBe(400);
        });
    });

    describe('GET /books/:bookId', () => {
        it('trả chi tiết sách của mình', async () => {
            const { token } = await signUp();
            const created = await createBook(token, { description: 'Mô tả', ageMin: 3, ageMax: 6 });
            const id = created.body.data.book.id;

            const res = await request(app).get(`/api/v1/books/${id}`).set(auth(token));
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                id,
                description: 'Mô tả',
                ageMin: 3,
                ageMax: 6,
                pageFormat: 'A4',
                currentVersion: null,
                pages: [],
            });
        });

        it('sách của người khác hoặc id sai -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const id = (await createBook(a.token)).body.data.book.id;

            expect((await request(app).get(`/api/v1/books/${id}`).set(auth(b.token))).status).toBe(
                404,
            );
            expect(
                (await request(app).get('/api/v1/books/khong-phai-uuid').set(auth(a.token))).status,
            ).toBe(404);
        });
    });

    describe('PATCH /books/:bookId', () => {
        it('sửa tên và mô tả; chuỗi rỗng thành null', async () => {
            const { token } = await signUp();
            const id = (await createBook(token, { description: 'cũ' })).body.data.book.id;
            const res = await request(app)
                .patch(`/api/v1/books/${id}`)
                .set(auth(token))
                .send({ title: 'Tên mới', description: '' });
            expect(res.status).toBe(200);
            expect(res.body.data.title).toBe('Tên mới');

            const { rows } = await pool.query('SELECT description FROM books WHERE id = $1', [id]);
            expect(rows[0].description).toBeNull();
        });

        it('xoá độ tuổi bằng null (không bị giữ giá trị cũ)', async () => {
            const { token } = await signUp();
            const id = (await createBook(token, { ageMin: 3, ageMax: 6 })).body.data.book.id;
            const res = await request(app)
                .patch(`/api/v1/books/${id}`)
                .set(auth(token))
                .send({ ageMin: null });
            expect(res.status).toBe(200);
            const { rows } = await pool.query('SELECT age_min, age_max FROM books WHERE id = $1', [
                id,
            ]);
            expect(rows[0]).toEqual({ age_min: null, age_max: 6 });
        });

        it('tuổi tối đa nhỏ hơn tối thiểu hiện có -> 400 gắn vào ageMax', async () => {
            const { token } = await signUp();
            const id = (await createBook(token, { ageMin: 5 })).body.data.book.id;
            const res = await request(app)
                .patch(`/api/v1/books/${id}`)
                .set(auth(token))
                .send({ ageMax: 2 });
            expect(res.status).toBe(400);
            expect(res.body.error.details[0].path).toBe('ageMax');
        });

        it('đổi sang khổ cố định thì tỉ lệ theo khổ; đổi sang CUSTOM mà thiếu tỉ lệ -> 400', async () => {
            const { token } = await signUp();
            const id = (await createBook(token)).body.data.book.id;

            const missing = await request(app)
                .patch(`/api/v1/books/${id}`)
                .set(auth(token))
                .send({ pageFormat: 'CUSTOM' });
            expect(missing.status).toBe(400);
            expect(missing.body.error.details[0].path).toBe('pageAspect');

            const square = await request(app)
                .patch(`/api/v1/books/${id}`)
                .set(auth(token))
                .send({ pageFormat: 'SQUARE' });
            expect(square.status).toBe(200);
            const { rows } = await pool.query(
                'SELECT page_format, page_aspect::float AS aspect FROM books WHERE id = $1',
                [id],
            );
            expect(rows[0]).toMatchObject({ page_format: 'SQUARE', aspect: 1 });
        });

        it('body rỗng -> 400; sách người khác -> 404', async () => {
            const a = await signUp();
            const b = await signUp();
            const id = (await createBook(a.token)).body.data.book.id;
            expect(
                (await request(app).patch(`/api/v1/books/${id}`).set(auth(a.token)).send({}))
                    .status,
            ).toBe(400);
            expect(
                (
                    await request(app)
                        .patch(`/api/v1/books/${id}`)
                        .set(auth(b.token))
                        .send({ title: 'x' })
                ).status,
            ).toBe(404);
        });
    });

    describe('PATCH /books/:bookId/visibility', () => {
        it('đặt công khai rồi riêng tư', async () => {
            const { token } = await signUp();
            const id = (await createBook(token)).body.data.book.id;
            const pub = await request(app)
                .patch(`/api/v1/books/${id}/visibility`)
                .set(auth(token))
                .send({ visibility: 'PUBLIC' });
            expect(pub.status).toBe(200);
            expect(pub.body.data.visibility).toBe('PUBLIC');
        });

        it('sách bị quản trị viên gỡ: mở công khai -> 403 BOOK_TAKEN_DOWN, để riêng tư thì được', async () => {
            const { token } = await signUp();
            const id = (await createBook(token)).body.data.book.id;
            await pool.query(
                `UPDATE books SET taken_down_at = now(), taken_down_reason = 'vi phạm' WHERE id = $1`,
                [id],
            );

            const pub = await request(app)
                .patch(`/api/v1/books/${id}/visibility`)
                .set(auth(token))
                .send({ visibility: 'PUBLIC' });
            expect(pub.status).toBe(403);
            expect(pub.body.error.code).toBe('BOOK_TAKEN_DOWN');

            const priv = await request(app)
                .patch(`/api/v1/books/${id}/visibility`)
                .set(auth(token))
                .send({ visibility: 'PRIVATE' });
            expect(priv.status).toBe(200);
        });
    });

    describe('thùng rác: DELETE, GET /books/trash, POST /books/:bookId/restore', () => {
        it('xoá mềm -> biến khỏi danh sách, hiện trong thùng rác, khôi phục lại được', async () => {
            const { token } = await signUp();
            const id = (await createBook(token)).body.data.book.id;

            const del = await request(app).delete(`/api/v1/books/${id}`).set(auth(token));
            expect(del.status).toBe(204);

            const list = await request(app).get('/api/v1/books').set(auth(token));
            expect(list.body.meta.total).toBe(0);
            expect((await request(app).get(`/api/v1/books/${id}`).set(auth(token))).status).toBe(
                404,
            );

            const trash = await request(app).get('/api/v1/books/trash').set(auth(token));
            expect(trash.status).toBe(200);
            expect(trash.body.meta.total).toBe(1);
            expect(trash.body.data[0]).toMatchObject({ id, deletedAt: expect.any(String) });

            const restored = await request(app)
                .post(`/api/v1/books/${id}/restore`)
                .set(auth(token));
            expect(restored.status).toBe(200);
            expect(restored.body.data.id).toBe(id);
            expect((await request(app).get('/api/v1/books').set(auth(token))).body.meta.total).toBe(
                1,
            );
        });

        it('xoá khi còn tác vụ đang chạy -> 409 JOB_IN_PROGRESS', async () => {
            const { token, userId } = await signUp();
            const id = (await createBook(token)).body.data.book.id;
            await pool.query(
                `INSERT INTO jobs (type, status, ref_type, ref_id, created_by)
                 VALUES ('PUBLISH_BOOK', 'RUNNING', 'BOOK', $1, $2)`,
                [id, userId],
            );
            const res = await request(app).delete(`/api/v1/books/${id}`).set(auth(token));
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('JOB_IN_PROGRESS');
        });

        it('quá 30 ngày trong thùng rác thì không còn thấy và không khôi phục được', async () => {
            const { token } = await signUp();
            const id = (await createBook(token)).body.data.book.id;
            await request(app).delete(`/api/v1/books/${id}`).set(auth(token));
            await pool.query(
                `UPDATE books SET deleted_at = now() - interval '31 days' WHERE id = $1`,
                [id],
            );

            const trash = await request(app).get('/api/v1/books/trash').set(auth(token));
            expect(trash.body.meta.total).toBe(0);
            const restore = await request(app).post(`/api/v1/books/${id}/restore`).set(auth(token));
            expect(restore.status).toBe(404);
        });

        it('không xoá hay khôi phục được sách của người khác', async () => {
            const a = await signUp();
            const b = await signUp();
            const id = (await createBook(a.token)).body.data.book.id;
            expect(
                (await request(app).delete(`/api/v1/books/${id}`).set(auth(b.token))).status,
            ).toBe(404);
            await request(app).delete(`/api/v1/books/${id}`).set(auth(a.token));
            expect(
                (await request(app).post(`/api/v1/books/${id}/restore`).set(auth(b.token))).status,
            ).toBe(404);
        });
    });
});
