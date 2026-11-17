import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../config/env';
import { completeInteraction } from '../provider';

const original = {
    AI_BASE_URL: env.AI_BASE_URL,
    AI_MODEL: env.AI_MODEL,
    AI_API_KEY: env.AI_API_KEY,
    AI_TIMEOUT_MS: env.AI_TIMEOUT_MS,
};
const envelope = (extra = {}) => ({
    model: 'pinned-model',
    choices: [
        {
            finish_reason: 'stop',
            message: { content: '{"status":"unsupported","message":"Không hỗ trợ"}' },
        },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    ...extra,
});
beforeEach(() =>
    Object.assign(env, {
        AI_BASE_URL: 'http://localhost:11434/v1',
        AI_MODEL: 'pinned-model',
        AI_API_KEY: '',
        AI_TIMEOUT_MS: 1000,
    }),
);
afterEach(() => {
    Object.assign(env, original);
    vi.unstubAllGlobals();
});

describe('bounded OpenAI-compatible provider', () => {
    it('sends only fixed model parameters, preserves usage and supports local models without a key', async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json(envelope()));
        vi.stubGlobal('fetch', fetcher);
        const result = await completeInteraction([{ role: 'user', content: 'JSON' }]);
        expect(result).toMatchObject({ model: 'pinned-model', inputTokens: 100, outputTokens: 20 });
        const init = fetcher.mock.calls[0]?.[1];
        expect(JSON.parse(init.body)).toMatchObject({
            model: 'pinned-model',
            stream: false,
            max_completion_tokens: 4096,
            response_format: { type: 'json_object' },
        });
        expect(init.redirect).toBe('error');
        expect(init.headers.Authorization).toBeUndefined();
    });
    it('does not call provider while unconfigured or remote without a key', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        env.AI_MODEL = '';
        await expect(completeInteraction([])).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
        env.AI_MODEL = 'model';
        env.AI_BASE_URL = 'https://example.test/v1';
        await expect(completeInteraction([])).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([
        () => new Response('secret upstream account error', { status: 401 }),
        () => new Response('x'.repeat(256001)),
        () =>
            Response.json(
                envelope({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
            ),
        () =>
            Response.json(
                envelope({
                    choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'no' } }],
                }),
            ),
    ])(
        'rejects incomplete/oversized/error responses without leaking provider details %#',
        async (response) => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
            await expect(completeInteraction([])).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
            await expect(completeInteraction([])).rejects.not.toThrow('secret');
        },
    );
    it('keeps absent token usage null instead of reporting zero cost', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(Response.json(envelope({ usage: undefined }))),
        );
        expect((await completeInteraction([])).inputTokens).toBeNull();
    });
    it('times out and propagates caller cancellation without automatic retries', async () => {
        const fetcher = vi.fn(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    if (init.signal.aborted) reject(init.signal.reason);
                    else
                        init.signal.addEventListener('abort', () => reject(init.signal.reason), {
                            once: true,
                        });
                }),
        );
        vi.stubGlobal('fetch', fetcher);
        const controller = new AbortController();
        controller.abort();
        await expect(completeInteraction([], controller.signal)).rejects.toMatchObject({
            code: 'AI_UNAVAILABLE',
        });
        await expect(completeInteraction([])).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
