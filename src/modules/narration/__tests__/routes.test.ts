import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { env } from '../../../config/env';
import { pool } from '../../../db';
import {
    isNarrationMp3,
    NARRATION_MAX_BYTES,
    NarrationBodySchema,
} from '../../../schema/api/narration.schema';
import { verifyFixtureEmail } from '../../../test/verified-author';
import { generateNarration } from '../narration.service';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const mock = vi.fn<typeof fetch>();
const body = { text: 'Xin chào các bạn.', voice: 'maichi' };
const mp3 = readFileSync(new URL('./fixtures/narration.mp3', import.meta.url));
const audio = () => new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });
let token: string, otherToken: string, userId: string;
const send = (payload: Record<string, unknown> = body, bearer = token) =>
    request(app)
        .post('/api/v1/assets/narration/generate')
        .set('Authorization', `Bearer ${bearer}`)
        .send(payload);

suite('ZeroTTS narration authorization and generation', () => {
    beforeAll(async () => {
        const register = async () =>
            (
                await request(app)
                    .post('/api/v1/auth/register')
                    .send({
                        email: `tts-${crypto.randomUUID()}@example.com`,
                        password: 'Matkhau-123',
                        displayName: 'TTS test',
                    })
            ).body.data;
        const owner = await register(),
            other = await register();
        await verifyFixtureEmail(owner.user.id);
        await verifyFixtureEmail(other.user.id);
        token = owner.accessToken;
        userId = owner.user.id;
        otherToken = other.accessToken;
    });
    const originalUrl = env.ZEROTTS_URL,
        originalKey = env.ZEROTTS_API_KEY;
    beforeEach(() => {
        env.ZEROTTS_URL = 'http://127.0.0.1:8010';
        env.ZEROTTS_API_KEY = 'internal-secret';
        vi.stubGlobal('fetch', mock);
        mock.mockResolvedValue(audio());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        mock.mockReset();
        env.ZEROTTS_URL = originalUrl;
        env.ZEROTTS_API_KEY = originalKey;
    });
    it('checks authentication before contacting TTS', async () => {
        expect((await send(body, '')).status).toBe(401);
        expect((await request(app).get('/api/v1/assets/narration/voices')).status).toBe(401);
        expect(mock).not.toHaveBeenCalled();
    });
    it('lets an author without any books create a library preview', async () => {
        expect((await send(body, otherToken)).status).toBe(200);
    });
    it('rejects empty, nonverbal, oversized text and unsafe voice ids', async () => {
        for (const payload of [
            { ...body, text: ' ' },
            { ...body, text: '!!!' },
            { ...body, text: 'a'.repeat(1501) },
            { ...body, voice: '../secret' },
            { ...body, speed: 0.7 },
            { ...body, speed: true },
            { ...body, temperature: 1.1 },
            { ...body, voiceStrength: 2 },
            { ...body, pause: 'invalid' },
        ]) {
            expect((await send(payload)).status).toBe(400);
        }
        expect(mock).not.toHaveBeenCalled();
    });
    it('forwards validated speech settings to the service', async () => {
        const custom = { ...body, speed: 0.8, pause: 'long', temperature: 0.6, voiceStrength: 1.2 };
        expect((await send(custom)).status).toBe(200);
        expect(mock).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                body: JSON.stringify(NarrationBodySchema.parse(custom)),
            }),
        );
    });
    it('returns available voices without exposing service credentials', async () => {
        mock.mockResolvedValueOnce(
            new Response(JSON.stringify([{ id: 'maichi', name: 'Mai Chi' }])),
        );
        const response = await request(app)
            .get('/api/v1/assets/narration/voices')
            .set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: [{ id: 'maichi', name: 'Mai Chi' }] });
        expect(response.headers['cache-control']).toBe('no-store');
    });
    it('returns a complete MP3 without creating an asset before confirmation', async () => {
        const before = await pool.query('SELECT id,status,name FROM assets WHERE owner_id=$1', [
            userId,
        ]);
        const response = await send();
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/^audio\/mpeg/);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toEqual(mp3);
        expect(mock).toHaveBeenCalledWith(
            'http://127.0.0.1:8010/speech',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer internal-secret' }),
                body: JSON.stringify(NarrationBodySchema.parse(body)),
                redirect: 'error',
            }),
        );
        expect(
            (await pool.query('SELECT id,status,name FROM assets WHERE owner_id=$1', [userId]))
                .rows,
        ).toEqual(before.rows);
    });
    it('rejects corrupt, oversized and non-audio responses without leaking upstream errors', async () => {
        for (const response of [
            new Response('private upstream failure', { status: 500 }),
            new Response('not audio'),
            new Response(mp3.subarray(0, mp3.length - 1), {
                headers: { 'Content-Type': 'audio/mpeg' },
            }),
            new Response(mp3, { headers: { 'Content-Type': 'audio/wav' } }),
            new Response(Buffer.alloc(mp3.length), { headers: { 'Content-Type': 'audio/mpeg' } }),
            new Response(Buffer.alloc(NARRATION_MAX_BYTES + 1), {
                headers: { 'Content-Type': 'audio/mpeg' },
            }),
        ]) {
            mock.mockResolvedValueOnce(response);
            const result = await send();
            expect(result.status).toBe(503);
            expect(result.body.error.code).toBe('AI_UNAVAILABLE');
            expect(JSON.stringify(result.body)).not.toContain('private upstream');
        }
        expect((await send()).status).toBe(200);
    });
    it('allows only one active generation and releases the slot after success', async () => {
        let finish!: (response: Response) => void;
        mock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = send().then((response) => response);
        await vi.waitFor(() => expect(mock).toHaveBeenCalledOnce());
        expect((await send()).status).toBe(429);
        finish(audio());
        expect((await first).status).toBe(200);
        expect((await send()).status).toBe(200);
    });
    it('handles disabled service, upstream busy and cancellation without keeping the slot', async () => {
        env.ZEROTTS_URL = '';
        expect((await send()).status).toBe(503);
        expect(mock).not.toHaveBeenCalled();
        env.ZEROTTS_URL = 'http://127.0.0.1:8010';
        mock.mockResolvedValueOnce(new Response('', { status: 429 }));
        expect((await send()).status).toBe(429);
        mock.mockImplementationOnce(async (_url, options) => {
            options?.signal?.throwIfAborted();
            return audio();
        });
        await expect(
            generateNarration(userId, NarrationBodySchema.parse(body), AbortSignal.abort()),
        ).rejects.toMatchObject({
            code: 'AI_UNAVAILABLE',
        });
        expect((await send()).status).toBe(200);
    });
    it.runIf(process.env.ZEROTTS_SMOKE === '1')(
        'generates speech through the authenticated API with the real local model',
        async () => {
            vi.unstubAllGlobals();
            env.ZEROTTS_URL = originalUrl;
            env.ZEROTTS_API_KEY = originalKey;
            const voices = await request(app)
                .get('/api/v1/assets/narration/voices')
                .set('Authorization', `Bearer ${token}`);
            expect(voices.status).toBe(200);
            expect(voices.body.data).toContainEqual({ id: 'maichi', name: 'Mai Chi' });
            const started = Date.now();
            const response = await send({
                ...body,
                text: 'Một buổi sáng, Rùa và Thỏ hẹn nhau thi chạy qua khu rừng.',
                speed: 1.2,
                pause: 'long',
                temperature: 0.6,
                voiceStrength: 1.2,
            });
            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toMatch(/^audio\/mpeg/);
            expect(isNarrationMp3(response.body)).toBe(true);
            expect(response.body.length).toBeGreaterThan(10000);
            console.info(
                `Real ZeroTTS API: ${response.body.length} bytes in ${Date.now() - started} ms`,
            );
        },
        190000,
    );
});
