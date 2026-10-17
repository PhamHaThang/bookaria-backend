import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });

async function register() {
    const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
            email: `job-api-${randomUUID()}@example.com`,
            displayName: 'Tác giả',
            password: 'Matkhau-123',
        });
    expect(response.status).toBe(201);
    return {
        userId: response.body.data.user.id as string,
        token: response.body.data.accessToken as string,
    };
}

suite('GET /jobs/:jobId', () => {
    it('shows a job only to its creator', async () => {
        const author = await register();
        const stranger = await register();
        const created = await request(app)
            .post('/api/v1/books')
            .set('Authorization', `Bearer ${author.token}`)
            .send({ title: 'Sách theo dõi job' });
        expect(created.status).toBe(201);
        const bookId = created.body.data.book.id as string;

        const inserted = await pool.query<{ id: string }>(
            `INSERT INTO jobs (type, ref_type, ref_id, created_by)
             VALUES ('EXPORT_PDF', 'BOOK', $1, $2) RETURNING id`,
            [bookId, author.userId],
        );
        const jobId = inserted.rows[0]?.id;
        expect(jobId).toBeDefined();

        const owner = await request(app)
            .get(`/api/v1/jobs/${jobId}`)
            .set('Authorization', `Bearer ${author.token}`);
        expect(owner.status).toBe(200);
        expect(owner.body.data).toMatchObject({
            id: jobId,
            type: 'EXPORT_PDF',
            status: 'QUEUED',
            progress: 0,
            ref: { type: 'BOOK', id: bookId },
        });

        const other = await request(app)
            .get(`/api/v1/jobs/${jobId}`)
            .set('Authorization', `Bearer ${stranger.token}`);
        expect(other.status).toBe(404);
        expect((await request(app).get(`/api/v1/jobs/${jobId}`)).status).toBe(401);

        await pool.query('UPDATE jobs SET created_by = NULL WHERE id = $1', [jobId]);
        const systemJob = await request(app)
            .get(`/api/v1/jobs/${jobId}`)
            .set('Authorization', `Bearer ${author.token}`);
        expect(systemJob.status).toBe(404);
    });
});
