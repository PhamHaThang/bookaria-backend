import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { buildOpenApi } from '../../../schema/openapi';
import { illustration } from '../../../worker/score/__tests__/fixtures';
import { starScore } from '../../../worker/score/vision';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp(),
    endpoint = '/api/v1/admin/bookaria-markers/test';
suite('admin temporary marker scoring', () => {
    let admin = '',
        author = '',
        adminId = '',
        backupId = '';
    beforeAll(async () => {
        async function account(label: string) {
            const email = `markertest-${label}-${Date.now()}@example.com`;
            const res = await request(app)
                .post('/api/v1/auth/register')
                .send({ email, password: 'Matkhau-123', displayName: label });
            expect(res.status).toBe(201);
            return {
                email,
                token: res.body.data.accessToken as string,
                id: res.body.data.user.id as string,
            };
        }
        const backup = await account('backup');
        backupId = backup.id;
        await pool.query(`UPDATE users SET role='ADMIN' WHERE id=$1`, [backupId]);
        const a = await account('admin'),
            b = await account('author');
        author = b.token;
        adminId = a.id;
        await pool.query(`UPDATE users SET role='ADMIN' WHERE id=$1`, [a.id]);
        const login = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: a.email, password: 'Matkhau-123' });
        admin = login.body.data.accessToken;
    });
    const send = (bytes: Buffer, type = 'image/png', token = admin) =>
        request(app)
            .post(endpoint)
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', type)
            .send(bytes);
    it('requires authentication and a current admin role', async () => {
        expect(
            (
                await request(app)
                    .post(endpoint)
                    .set('Content-Type', 'image/png')
                    .send(Buffer.from('x'))
            ).status,
        ).toBe(401);
        expect((await send(Buffer.from('x'), 'image/png', author)).status).toBe(403);
        await pool.query(`UPDATE users SET role='AUTHOR' WHERE id=$1`, [adminId]);
        try {
            expect((await send(Buffer.from('x'))).status).toBe(403);
        } finally {
            await pool.query(`UPDATE users SET role='ADMIN' WHERE id=$1`, [adminId]);
            await pool.query(`UPDATE users SET role='AUTHOR' WHERE id=$1`, [backupId]);
        }
    });
    it('returns the real scorer output with points and consistent grid without persisting records', async () => {
        const counts = async () =>
            (
                await pool.query(
                    `SELECT (SELECT count(*) FROM assets)::int AS assets,(SELECT count(*) FROM pages)::int AS pages,(SELECT count(*) FROM bookaria_markers)::int AS markers`,
                )
            ).rows[0];
        const before = await counts(),
            image = await illustration(41),
            res = await send(image);
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d.algorithm).toBe('ORB');
        expect(d.features).toBeGreaterThan(100);
        expect(d.points).toHaveLength(d.features);
        expect(d.cells).toHaveLength(16);
        expect(d.cells.reduce((a: number, b: number) => a + b, 0)).toBe(d.features);
        expect(d.coverage).toBe(d.cells.filter((n: number) => n > 0).length / 16);
        expect(d.score).toBe(starScore(d.features, d.coverage));
        expect(d.image).toMatch(/^data:image\/png;base64,/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(await counts()).toEqual(before);
    });
    it('shows a blank image as one star with sixteen empty cells', async () => {
        const image = await sharp({
            create: { width: 640, height: 640, channels: 3, background: 'white' },
        })
            .png()
            .toBuffer();
        const res = await send(image);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            score: 1,
            features: 0,
            coverage: 0,
            cells: Array(16).fill(0),
        });
    });
    it('rejects corrupt, unsupported and oversized images without disabling subsequent analysis', async () => {
        expect((await send(Buffer.from('not a PNG'))).status).toBe(400);
        expect((await send(Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(422);
        expect((await send(Buffer.alloc(10 * 1024 * 1024 + 1))).status).toBe(413);
        const png = await sharp({
            create: { width: 40, height: 40, channels: 3, background: 'white' },
        })
            .png()
            .toBuffer();
        expect((await send(png)).status).toBe(400);
        const valid = await sharp({
            create: { width: 256, height: 256, channels: 3, background: 'white' },
        })
            .png()
            .toBuffer();
        expect((await send(valid)).status).toBe(200);
    });
});
describe('marker test API contract', () => {
    it('documents raw binary upload and the analysis response', () => {
        const doc = buildOpenApi() as {
            paths: Record<
                string,
                Record<
                    string,
                    {
                        requestBody: { content: Record<string, unknown> };
                        responses: Record<string, unknown>;
                    }
                >
            >;
        };
        const operation = doc.paths['/admin/bookaria-markers/test']?.post;
        expect(operation?.requestBody.content['application/octet-stream']).toBeDefined();
        expect(operation?.responses['200']).toBeDefined();
    });
});
