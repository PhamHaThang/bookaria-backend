import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PaginationQuerySchema } from '../schema';
import { errorMiddleware } from './error.middleware';
import { rateLimitMiddleware } from './rate-limit.middleware';
import { requestIdMiddleware } from './request-id.middleware';
import { validateMiddleware } from './validate.middleware';

function makeApp(setup: (app: express.Express) => void) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(requestIdMiddleware, express.json());
    setup(app);
    app.use(errorMiddleware);
    return app;
}

describe('validateMiddleware', () => {
    const app = makeApp((a) => {
        a.post(
            '/u/:id',
            validateMiddleware({
                params: z.object({ id: z.uuid() }),
                query: PaginationQuerySchema,
                body: z.object({
                    email: z.string().trim().toLowerCase().pipe(z.email()),
                    password: z.string().min(8),
                }),
            }),
            (req, res) => {
                res.json({ params: req.params, query: req.query, body: req.body });
            },
        );
    });
    const id = '3f2b1c4e-5a6d-4e8f-9a0b-1c2d3e4f5a6b';

    it('thay giá trị gốc bằng dữ liệu đã parse (ép kiểu, cắt khoảng trắng, bỏ trường lạ)', async () => {
        const res = await request(app)
            .post(`/u/${id}?page=2&limit=5&x=1`)
            .send({ email: '  A@X.com ', password: '12345678', extra: 'bo' });
        expect(res.status).toBe(200);
        expect(res.body.query).toEqual({ page: 2, limit: 5 });
        expect(res.body.body).toEqual({ email: 'a@x.com', password: '12345678' });
    });

    it('gom lỗi của cả params, query và body thành VALIDATION_ERROR', async () => {
        const res = await request(app)
            .post('/u/khong-phai-uuid?limit=1000')
            .send({ email: 'sai', password: '1' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        const paths = res.body.error.details.map((d: { path: string }) => d.path);
        expect(paths).toEqual(expect.arrayContaining(['id', 'limit', 'email', 'password']));
    });
});

describe('rateLimitMiddleware', () => {
    it('vượt giới hạn -> 429 RATE_LIMITED kèm Retry-After, tính riêng từng IP', async () => {
        const app = makeApp((a) => {
            a.post(
                '/x',
                rateLimitMiddleware({ windowMs: 60_000, limit: 2, enabled: true }),
                (_req, res) => {
                    res.json({ ok: true });
                },
            );
        });
        const hit = (ip: string) => request(app).post('/x').set('X-Forwarded-For', ip);
        expect((await hit('1.1.1.1')).status).toBe(200);
        expect((await hit('1.1.1.1')).status).toBe(200);
        const blocked = await hit('1.1.1.1');
        expect(blocked.status).toBe(429);
        expect(blocked.body.error.code).toBe('RATE_LIMITED');
        expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        expect((await hit('2.2.2.2')).status).toBe(200);
    });

    it('skipSuccessfulRequests: request thành công không bị tính', async () => {
        const app = makeApp((a) => {
            a.post(
                '/login',
                rateLimitMiddleware({
                    windowMs: 60_000,
                    limit: 2,
                    enabled: true,
                    skipSuccessfulRequests: true,
                }),
                (req, res) => {
                    res.status(req.body.ok ? 200 : 401).json({});
                },
            );
        });
        for (let i = 0; i < 5; i++) {
            expect((await request(app).post('/login').send({ ok: true })).status).toBe(200);
        }
        expect((await request(app).post('/login').send({ ok: false })).status).toBe(401);
        expect((await request(app).post('/login').send({ ok: false })).status).toBe(401);
        expect((await request(app).post('/login').send({ ok: false })).status).toBe(429);
    });

    it('enabled=false thì không giới hạn', async () => {
        const app = makeApp((a) => {
            a.post(
                '/x',
                rateLimitMiddleware({ windowMs: 60_000, limit: 1, enabled: false }),
                (_req, res) => {
                    res.json({});
                },
            );
        });
        for (let i = 0; i < 4; i++) expect((await request(app).post('/x')).status).toBe(200);
    });
});
