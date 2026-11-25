import { setTimeout as sleep } from 'node:timers/promises';
import { env, logger } from '../../config';
import {
    isNarrationMp3,
    NARRATION_MAX_BYTES,
    type NarrationBody,
    NarrationVoicesSchema,
} from '../../schema/api/narration.schema';
import { AppError } from '../../utils';

const VOICES_MAX_TIMEOUT_MS = 45_000;
const WARMUP_MAX_TIMEOUT_MS = 60_000;
const VOICES_CACHE_TTL_MS = 10 * 60 * 1000;
const TRANSIENT_UPSTREAM_STATUSES = new Set([502, 503, 504]);

type VoicesList = ReturnType<typeof NarrationVoicesSchema.parse>;

// shortcut: concurrency is per API process; move generation to jobs before adding API replicas.
const activeUsers = new Set<string>();

let voicesCache: { key: string; voices: VoicesList; expiresAt: number } | null = null;
let warmupInFlight: Promise<void> | null = null;

class TransientTtsError extends Error {}

function getTtsBaseUrl(): string {
    return env.ZEROTTS_URL.replace(/\/$/, '');
}

function getRetryDelaysMs(): number[] {
    return env.NODE_ENV === 'test' ? [10, 20] : [1_500, 3_000];
}

function isTransientNetworkError(cause: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    return cause instanceof TypeError;
}

async function fetchTtsOnce(
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    body?: NarrationBody,
): Promise<Response> {
    const headers: Record<string, string> = {};
    if (env.ZEROTTS_API_KEY) headers.Authorization = `Bearer ${env.ZEROTTS_API_KEY}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        redirect: 'error',
        signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 429) {
        await response.body?.cancel();
        throw new AppError('RATE_LIMITED', 'Dịch vụ đang tạo lời đọc khác. Hãy thử lại sau.', {
            retryAfterSeconds: 10,
        });
    }
    if (TRANSIENT_UPSTREAM_STATUSES.has(response.status)) {
        await response.body?.cancel();
        throw new TransientTtsError(`Upstream TTS unavailable (${response.status})`);
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error('TTS request failed');
    }
    return response;
}

async function requestTts(
    path: string,
    signal: AbortSignal,
    body?: NarrationBody,
    retryDelaysMs = getRetryDelaysMs(),
): Promise<Response> {
    if (!env.ZEROTTS_URL)
        throw new AppError('AI_UNAVAILABLE', 'Dịch vụ tạo lời đọc chưa được cấu hình.');
    const baseUrl = getTtsBaseUrl();
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await fetchTtsOnce(baseUrl, path, signal, body);
        } catch (cause) {
            const delayMs = retryDelaysMs[attempt];
            const retryable =
                cause instanceof TransientTtsError || isTransientNetworkError(cause, signal);
            if (!retryable || delayMs === undefined || signal.aborted) throw cause;
            await sleep(delayMs, undefined, { signal });
        }
    }
}

async function readBytes(response: Response, limit: number) {
    if (!response.body) throw new Error('Missing audio response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limit) throw new Error('TTS response exceeds limit');
            chunks.push(chunk.value);
        }
        return Buffer.concat(chunks);
    } finally {
        await reader.cancel().catch(() => {});
    }
}

function unavailable(cause: unknown, signal: AbortSignal, timeoutMessage: string): never {
    if (cause instanceof AppError) throw cause;
    throw new AppError(
        'AI_UNAVAILABLE',
        signal.aborted ? timeoutMessage : 'Dịch vụ tạo âm thanh không khả dụng. Hãy thử lại sau.',
    );
}

/** Pre-warm ZeroTTS in the background so cold-start wakes do not block user requests. */
export async function warmUpNarration(): Promise<void> {
    if (!env.ZEROTTS_URL) return;
    if (warmupInFlight) return warmupInFlight;
    const timeoutMs = Math.min(Math.max(env.ZEROTTS_TIMEOUT_MS, 10_000), WARMUP_MAX_TIMEOUT_MS);
    const task = (async () => {
        try {
            const response = await requestTts(
                '/health',
                AbortSignal.timeout(timeoutMs),
                undefined,
                [env.NODE_ENV === 'test' ? 10 : 2_500],
            );
            await response.body?.cancel();
            logger.info('Đã đánh thức dịch vụ ZeroTTS sẵn sàng.');
        } catch (err) {
            logger.debug({ err }, 'Chưa thể khởi động trước dịch vụ ZeroTTS.');
        }
    })();
    warmupInFlight = task.finally(() => {
        if (warmupInFlight === task) warmupInFlight = null;
    });
    return warmupInFlight;
}

export function resetNarrationStateForTest(): void {
    voicesCache = null;
    warmupInFlight = null;
}

export async function narrationVoices(
    signal: AbortSignal,
    options: { useCache?: boolean; timeoutMs?: number } = {},
) {
    const cacheKey = `${getTtsBaseUrl()}|${env.ZEROTTS_API_KEY}`;
    const shouldUseCache = options.useCache ?? env.NODE_ENV !== 'test';
    if (
        shouldUseCache &&
        voicesCache &&
        voicesCache.key === cacheKey &&
        voicesCache.expiresAt > Date.now()
    ) {
        if (env.NODE_ENV !== 'test') void warmUpNarration();
        return voicesCache.voices;
    }

    const timeoutMs = options.timeoutMs ?? Math.min(env.ZEROTTS_TIMEOUT_MS, VOICES_MAX_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
        const response = await requestTts('/voices', combined);
        const voices = NarrationVoicesSchema.parse(
            JSON.parse((await readBytes(response, 16000)).toString('utf8')),
        );
        if (shouldUseCache) {
            voicesCache = {
                key: cacheKey,
                voices,
                expiresAt: Date.now() + VOICES_CACHE_TTL_MS,
            };
        }
        return voices;
    } catch (cause) {
        if (signal.aborted && env.NODE_ENV !== 'test') void warmUpNarration();
        unavailable(
            cause,
            combined,
            'Dịch vụ giọng đọc đang khởi động hoặc phản hồi chậm. Hãy thử lại sau giây lát.',
        );
    }
}

export async function generateNarration(userId: string, body: NarrationBody, signal: AbortSignal) {
    if (activeUsers.size)
        throw new AppError('RATE_LIMITED', 'Dịch vụ đang tạo lời đọc khác. Hãy thử lại sau.', {
            retryAfterSeconds: 10,
        });
    activeUsers.add(userId);
    const controller = new AbortController();
    const combined = AbortSignal.any([
        signal,
        controller.signal,
        AbortSignal.timeout(env.ZEROTTS_TIMEOUT_MS),
    ]);
    try {
        const response = await requestTts('/speech', combined, body);
        if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'audio/mpeg')
            throw new Error('Expected MP3');
        const bytes = await readBytes(response, NARRATION_MAX_BYTES);
        if (!isNarrationMp3(bytes)) throw new Error('Invalid MP3');
        signal.throwIfAborted();
        return bytes;
    } catch (cause) {
        unavailable(
            cause,
            combined,
            'Tạo lời đọc đã hết thời gian chờ/bị hủy. Hãy thử đoạn ngắn hơn.',
        );
    } finally {
        controller.abort();
        activeUsers.delete(userId);
    }
}
