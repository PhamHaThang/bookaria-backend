import { env } from '../../config/env';
import {
    isNarrationMp3,
    NARRATION_MAX_BYTES,
    type NarrationBody,
    NarrationVoicesSchema,
} from '../../schema/api/narration.schema';
import { AppError } from '../../utils';

// shortcut: concurrency is per API process; move generation to jobs before adding API replicas.
const activeUsers = new Set<string>();

async function requestTts(path: string, signal: AbortSignal, body?: NarrationBody) {
    if (!env.ZEROTTS_URL)
        throw new AppError('AI_UNAVAILABLE', 'Dịch vụ tạo lời đọc chưa được cấu hình.');
    const headers: Record<string, string> = {};
    if (env.ZEROTTS_API_KEY) headers.Authorization = `Bearer ${env.ZEROTTS_API_KEY}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${env.ZEROTTS_URL.replace(/\/$/, '')}${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        redirect: 'error',
        signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 429 || response.status === 503) {
        await response.body?.cancel();
        throw new AppError('RATE_LIMITED', 'Dịch vụ đang tạo lời đọc khác. Hãy thử lại sau.', {
            retryAfterSeconds: 10,
        });
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error('TTS request failed');
    }
    return response;
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

function unavailable(cause: unknown, signal: AbortSignal): never {
    if (cause instanceof AppError) throw cause;
    throw new AppError(
        'AI_UNAVAILABLE',
        signal.aborted
            ? 'Tạo lời đọc đã hết thời gian chờ/bị hủy. Hãy thử đoạn ngắn hơn.'
            : 'Dịch vụ tạo âm thanh không khả dụng. Hãy thử lại sau.',
    );
}

export async function narrationVoices(signal: AbortSignal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    try {
        const response = await requestTts('/voices', combined);
        return NarrationVoicesSchema.parse(
            JSON.parse((await readBytes(response, 16000)).toString('utf8')),
        );
    } catch (cause) {
        unavailable(cause, combined);
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
        unavailable(cause, combined);
    } finally {
        controller.abort();
        activeUsers.delete(userId);
    }
}
