import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp();
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createAuthor(verified = true) {
    const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `publish-${unique()}@example.com`,
            password: 'Matkhau-123',
            displayName: 'An',
        });
    const token = response.body.data.accessToken as string;
    const userId = response.body.data.user.id as string;
    if (verified) {
        await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
    }
    return { token, userId };
}

async function createBook(userId: string, withAr = true) {
    const book = await pool.query<{ id: string }>(
        `INSERT INTO books (owner_id, title) VALUES ($1, 'Sách xuất bản') RETURNING id`,
        [userId],
    );
    const bookId = book.rows[0]?.id;
    if (!bookId) throw new Error('Không tạo được sách thử nghiệm');
    if (withAr) {
        const image = await pool.query<{ id: string }>(
            `INSERT INTO assets (owner_id, type, name, original_public_id, resource_type, format, size_bytes, status, meta)
             VALUES ($1, 'IMAGE', 'Ảnh trang', $2, 'image', 'png', 1000, 'READY', '{"width":640,"height":480}')
             RETURNING id`,
            [userId, `bookaria/${userId}/${unique()}`],
        );
        const imageId = image.rows[0]?.id;
        if (!imageId) throw new Error('Không tạo được ảnh thử nghiệm');
        await pool.query(
            `INSERT INTO pages (book_id, order_index, image_asset_id, marker_mode, marker_mind_public_id, marker_score)
             VALUES ($1, 0, $2, 'CUSTOM_MARKER', 'marker.mind', 3)`,
            [bookId, imageId],
        );
    }
    return bookId;
}

suite('publish (tích hợp)', () => {
    it('publish-check trả lỗi và tóm tắt; sách người khác bị 404', async () => {
        const owner = await createAuthor(false);
        const other = await createAuthor();
        const bookId = await createBook(owner.userId, false);

        const result = await request(app)
            .get(`/api/v1/books/${bookId}/publish-check`)
            .set(auth(owner.token));
        expect(result.status).toBe(200);
        expect(result.body.data).toMatchObject({
            canPublish: false,
            summary: { pageCount: 0, arPageCount: 0, downloadBytes: 0 },
            errors: [{ code: 'EMAIL_NOT_VERIFIED' }, { code: 'NO_AR_PAGE' }],
        });
        expect(
            (await request(app).get(`/api/v1/books/${bookId}/publish-check`).set(auth(other.token)))
                .status,
        ).toBe(404);
    });

    it('publish từ chối PRIVATE, email chưa xác nhận và sách không có trang AR', async () => {
        const unverified = await createAuthor(false);
        const bookWithAr = await createBook(unverified.userId);
        const privateResult = await request(app)
            .post(`/api/v1/books/${bookWithAr}/publish`)
            .set(auth(unverified.token))
            .send({ visibility: 'PRIVATE' });
        expect(privateResult.status).toBe(400);

        const emailResult = await request(app)
            .post(`/api/v1/books/${bookWithAr}/publish`)
            .set(auth(unverified.token))
            .send({ visibility: 'UNLISTED' });
        expect(emailResult.status).toBe(403);
        expect(emailResult.body.error.code).toBe('EMAIL_NOT_VERIFIED');

        const verified = await createAuthor();
        const emptyBook = await createBook(verified.userId, false);
        const blocked = await request(app)
            .post(`/api/v1/books/${emptyBook}/publish`)
            .set(auth(verified.token))
            .send({ visibility: 'UNLISTED' });
        expect(blocked.status).toBe(422);
        expect(blocked.body.error.details.errors).toMatchObject([{ code: 'NO_AR_PAGE' }]);
    });

    it('publish xếp một job, giữ nguyên sách và lần bấm sau nhận jobId cũ', async () => {
        const { token, userId } = await createAuthor();
        const bookId = await createBook(userId);
        const first = await request(app)
            .post(`/api/v1/books/${bookId}/publish`)
            .set(auth(token))
            .send({ visibility: 'PUBLIC' });
        expect(first.status).toBe(202);
        const jobId = first.body.data.jobId as string;
        const job = await pool.query<{ status: string; payload: { visibility: string } }>(
            'SELECT status, payload FROM jobs WHERE id = $1',
            [jobId],
        );
        expect(job.rows[0]).toMatchObject({ status: 'QUEUED', payload: { visibility: 'PUBLIC' } });
        const book = await pool.query<{ status: string; visibility: string; slug: string | null }>(
            'SELECT status, visibility, slug FROM books WHERE id = $1',
            [bookId],
        );
        expect(book.rows[0]).toEqual({ status: 'DRAFT', visibility: 'PRIVATE', slug: null });

        const second = await request(app)
            .post(`/api/v1/books/${bookId}/publish`)
            .set(auth(token))
            .send({ visibility: 'PUBLIC' });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatchObject({
            code: 'JOB_IN_PROGRESS',
            details: { jobId },
        });
    });

    it('cảnh báo cần acceptWarnings trước khi xếp job', async () => {
        const { token, userId } = await createAuthor();
        const bookId = await createBook(userId);
        await pool.query(`UPDATE pages SET scene = $2::jsonb WHERE book_id = $1`, [
            bookId,
            JSON.stringify({
                schemaVersion: 1,
                objects: Array.from({ length: 21 }, (_, i) => ({
                    id: `text${i}`,
                    type: 'text',
                    text: 'x',
                    transform: {},
                })),
                interactions: [],
            }),
        ]);
        const blocked = await request(app)
            .post(`/api/v1/books/${bookId}/publish`)
            .set(auth(token))
            .send({ visibility: 'UNLISTED' });
        expect(blocked.status).toBe(422);
        expect(blocked.body.error.details).toMatchObject({
            errors: [],
            warnings: [{ code: 'TOO_MANY_OBJECTS' }],
        });

        const accepted = await request(app)
            .post(`/api/v1/books/${bookId}/publish`)
            .set(auth(token))
            .send({ visibility: 'UNLISTED', acceptWarnings: true });
        expect(accepted.status).toBe(202);
    });

    it('versions mới nhất trước; unpublish giữ slug và làm hai lần vẫn thành công', async () => {
        const { token, userId } = await createAuthor();
        const bookId = await createBook(userId, false);
        const slug = `sach-${unique()}`;
        await pool.query(
            `UPDATE books SET status = 'PUBLISHED', visibility = 'PUBLIC', slug = $2 WHERE id = $1`,
            [bookId, slug],
        );
        for (const versionNo of [1, 2]) {
            await pool.query(
                `INSERT INTO book_versions (book_id, version_no, schema_version, manifest_public_id, mind_groups,
                                            page_count, ar_page_count, total_size_bytes, published_by)
                 VALUES ($1, $2, 1, $3, '[]', 1, 1, 1000, $4)`,
                [bookId, versionNo, `manifest/${bookId}/${versionNo}`, userId],
            );
        }
        const versions = await request(app)
            .get(`/api/v1/books/${bookId}/versions`)
            .set(auth(token));
        expect(versions.status).toBe(200);
        expect(
            versions.body.data.map((version: { versionNo: number }) => version.versionNo),
        ).toEqual([2, 1]);

        for (let i = 0; i < 2; i++) {
            const result = await request(app)
                .post(`/api/v1/books/${bookId}/unpublish`)
                .set(auth(token));
            expect(result.status).toBe(200);
            expect(result.body.data).toMatchObject({ status: 'PUBLISHED', visibility: 'PRIVATE' });
        }
        const book = await pool.query<{ slug: string }>('SELECT slug FROM books WHERE id = $1', [
            bookId,
        ]);
        expect(book.rows[0]?.slug).toBe(slug);
    });

    it('unpublish từ chối khi job xuất bản đang mở và trả jobId', async () => {
        const { token, userId } = await createAuthor();
        const bookId = await createBook(userId, false);
        const job = await pool.query<{ id: string }>(
            `INSERT INTO jobs (type, ref_type, ref_id, created_by)
             VALUES ('PUBLISH_BOOK', 'BOOK', $1, $2) RETURNING id`,
            [bookId, userId],
        );
        const result = await request(app)
            .post(`/api/v1/books/${bookId}/unpublish`)
            .set(auth(token));
        expect(result.status).toBe(409);
        expect(result.body.error).toMatchObject({
            code: 'JOB_IN_PROGRESS',
            details: { jobId: job.rows[0]?.id },
        });
    });
});
