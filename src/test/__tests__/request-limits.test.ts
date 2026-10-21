import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from '../../app';

it('applies the scene body limit to all accepted route spellings', async () => {
    const app = createApp({ rateLimit: false });
    const id = randomUUID();
    for (const path of [
        `/api/v1/pages/${id}/scene`,
        `/api/v1/pages/${id}/scene/`,
        `/API/V1/PAGES/${id}/SCENE`,
    ]) {
        // A valid-sized body reaches authentication; an oversized one stops at the parser.
        const accepted = await request(app)
            .patch(path)
            .send({ padding: 'x'.repeat(150 * 1024) });
        expect(accepted.status).toBe(401);
        const rejected = await request(app)
            .patch(path)
            .send({ padding: 'x'.repeat(513 * 1024) });
        expect(rejected.status).toBe(413);
        expect(rejected.body.error.code).toBe('FILE_TOO_LARGE');
    }
    const normal = await request(app)
        .patch(`/api/v1/pages/${id}`)
        .send({ padding: 'x'.repeat(101 * 1024) });
    expect(normal.status).toBe(413);
});

it.skipIf(Boolean(process.env.SKIP_DB_TESTS))(
    'invalid login bodies consume IP quota without blocking the email on another IP',
    async () => {
        const app = createApp({ rateLimit: true });
        app.set('trust proxy', 1);
        const email = `limits-${randomUUID()}@example.com`;
        const password = 'Review-password-123';
        const registered = await request(app)
            .post('/api/v1/auth/register')
            .send({ email, password, displayName: 'Limits test' });
        expect(registered.status).toBe(201);
        for (let i = 0; i < 10; i++) {
            const invalid = await request(app)
                .post('/api/v1/auth/login')
                .set('X-Forwarded-For', '192.0.2.1')
                .send({ email });
            expect(invalid.status).toBe(400);
        }
        const limited = await request(app)
            .post('/api/v1/auth/login')
            .set('X-Forwarded-For', '192.0.2.1')
            .send({ email });
        expect(limited.status).toBe(429);
        const legitimate = await request(app)
            .post('/api/v1/auth/login')
            .set('X-Forwarded-For', '192.0.2.2')
            .send({ email, password });
        expect(legitimate.status).toBe(200);
    },
);

it.skipIf(Boolean(process.env.SKIP_DB_TESTS))(
    'still limits valid failed login attempts for one email across different IPs',
    async () => {
        const app = createApp({ rateLimit: true });
        app.set('trust proxy', 1);
        const email = `absent-${randomUUID()}@example.com`;
        for (let i = 1; i <= 11; i++) {
            const response = await request(app)
                .post('/api/v1/auth/login')
                .set('X-Forwarded-For', `192.0.2.${i}`)
                .send({ email, password: 'Wrong-password-123' });
            expect(response.status).toBe(i <= 10 ? 401 : 429);
        }
    },
);
