import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorMiddleware } from './error.middleware';
import { rateLimitMiddleware } from './rate-limit.middleware';
import { requestIdMiddleware } from './request-id.middleware';

function makeApp(setup: (app: express.Express) => void) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(requestIdMiddleware, express.json());
    setup(app);
    app.use(errorMiddleware);
    return app;
}

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

describe('errorMiddleware: lỗi từ body-parser', () => {
    const app = makeApp((a) => {
        a.post('/echo', (req, res) => {
            res.json(req.body);
        });
    });

    it('JSON sai cú pháp -> 400 VALIDATION_ERROR (không phải 500)', async () => {
        const res = await request(app)
            .post('/echo')
            .set('Content-Type', 'application/json')
            .send("'{email:an@example.com}");
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});
