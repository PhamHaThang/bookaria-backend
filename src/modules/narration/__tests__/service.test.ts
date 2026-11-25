import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../config/env';
import { NarrationBodySchema } from '../../../schema/api/narration.schema';
import {
    generateNarration,
    narrationVoices,
    resetNarrationStateForTest,
    warmUpNarration,
} from '../narration.service';

const mockFetch = vi.fn<typeof fetch>();
const mp3 = readFileSync(new URL('./fixtures/narration.mp3', import.meta.url));
const audioResponse = () => new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });
const voicesPayload = [
    { id: 'maichi', name: 'Mai Chi' },
    { id: 'baotrang', name: 'Bảo Trang' },
];
const validBody = NarrationBodySchema.parse({ text: 'Xin chào Bookaria.', voice: 'maichi' });

describe('narration.service cold-start resilience', () => {
    const originalUrl = env.ZEROTTS_URL;
    const originalKey = env.ZEROTTS_API_KEY;

    beforeEach(() => {
        resetNarrationStateForTest();
        env.ZEROTTS_URL = 'https://tts.example.com';
        env.ZEROTTS_API_KEY = 'secret-key';
        vi.stubGlobal('fetch', mockFetch);
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        resetNarrationStateForTest();
        env.ZEROTTS_URL = originalUrl;
        env.ZEROTTS_API_KEY = originalKey;
    });

    it('retries transient 502/503/504 and network errors on /voices during cold start', async () => {
        mockFetch
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(new Response('booting', { status: 503 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(voicesPayload), { status: 200 }));

        const result = await narrationVoices(new AbortController().signal);
        expect(result).toEqual(voicesPayload);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('does not treat upstream 503 as rate limit and retries speech synthesis on cold start', async () => {
        mockFetch
            .mockResolvedValueOnce(new Response('waking', { status: 503 }))
            .mockResolvedValueOnce(new Response('gateway', { status: 502 }))
            .mockResolvedValueOnce(audioResponse());

        const audio = await generateNarration('user-1', validBody, new AbortController().signal);
        expect(audio).toEqual(mp3);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('never retries upstream 429 or 500 errors and preserves status semantics', async () => {
        mockFetch.mockResolvedValueOnce(new Response('', { status: 429 }));
        await expect(
            generateNarration('user-1', validBody, new AbortController().signal),
        ).rejects.toMatchObject({
            code: 'RATE_LIMITED',
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);

        mockFetch.mockResolvedValueOnce(new Response('internal error', { status: 500 }));
        await expect(
            generateNarration('user-1', validBody, new AbortController().signal),
        ).rejects.toMatchObject({
            code: 'AI_UNAVAILABLE',
        });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('surfaces a clear startup/slow-response message when /voices times out', async () => {
        mockFetch.mockImplementationOnce((_url, init) => {
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(init.signal?.reason ?? new DOMException('Timed out', 'TimeoutError'));
                });
            });
        });

        await expect(
            narrationVoices(new AbortController().signal, { timeoutMs: 25 }),
        ).rejects.toMatchObject({
            code: 'AI_UNAVAILABLE',
            message:
                'Dịch vụ giọng đọc đang khởi động hoặc phản hồi chậm. Hãy thử lại sau giây lát.',
        });
    });

    it('caches voices per endpoint/key when caching is enabled', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify(voicesPayload), { status: 200 }),
        );

        const first = await narrationVoices(new AbortController().signal, { useCache: true });
        const second = await narrationVoices(new AbortController().signal, { useCache: true });

        expect(first).toEqual(voicesPayload);
        expect(second).toEqual(voicesPayload);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        env.ZEROTTS_URL = 'https://tts-other.example.com';
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify([{ id: 'maichi', name: 'Mai Chi' }]), { status: 200 }),
        );
        const third = await narrationVoices(new AbortController().signal, { useCache: true });
        expect(third).toEqual([{ id: 'maichi', name: 'Mai Chi' }]);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('warms up /health non-blockingly and deduplicates concurrent warmups', async () => {
        let resolveHealth!: (response: Response) => void;
        mockFetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveHealth = resolve;
                }),
        );

        const p1 = warmUpNarration();
        const p2 = warmUpNarration();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(
            'https://tts.example.com/health',
            expect.objectContaining({ method: 'GET', redirect: 'error' }),
        );
        resolveHealth(new Response(JSON.stringify({ ready: true }), { status: 200 }));
        await Promise.all([p1, p2]);
    });

    it('swallows warmup errors gracefully when TTS is offline', async () => {
        mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
        await expect(warmUpNarration()).resolves.toBeUndefined();
    });
});
