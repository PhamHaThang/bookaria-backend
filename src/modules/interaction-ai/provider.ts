import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../utils/api-error';
import type { Complete } from './generation';

const responseSchema = z.object({
    model: z.string().max(200),
    choices: z
        .array(
            z.object({
                finish_reason: z.string().nullable(),
                message: z.object({
                    content: z.string().max(32000).nullable(),
                    refusal: z.string().nullable().optional(),
                }),
            }),
        )
        .min(1),
    usage: z
        .object({ prompt_tokens: z.int().nonnegative(), completion_tokens: z.int().nonnegative() })
        .optional(),
});

export const completeInteraction: Complete = async (messages, signal) => {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.AI_BASE_URL).hostname);
    if (!env.AI_MODEL || (!local && !env.AI_API_KEY))
        throw new AppError(
            'AI_UNAVAILABLE',
            'Backend chưa cấu hình mô hình AI. Bạn vẫn có thể tạo tương tác bằng bộ mẫu.',
        );
    const controller = new AbortController();
    const combined = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(env.AI_TIMEOUT_MS),
        ...(signal ? [signal] : []),
    ]);
    try {
        const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            redirect: 'error',
            signal: combined,
            headers: {
                'Content-Type': 'application/json',
                ...(env.AI_API_KEY ? { Authorization: `Bearer ${env.AI_API_KEY}` } : {}),
            },
            body: JSON.stringify({
                model: env.AI_MODEL,
                messages,
                stream: false,
                max_completion_tokens: 4096,
                response_format: { type: 'json_object' },
            }),
        });
        if (!response.ok || !response.body) throw new Error('provider unavailable');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 256000) throw new Error('provider response too large');
            chunks.push(chunk.value);
        }
        const parsed = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const choice = parsed.choices[0];
        if (choice?.finish_reason !== 'stop' || choice.message.refusal || !choice.message.content)
            throw new Error('incomplete provider response');
        return {
            text: choice.message.content,
            model: parsed.model,
            inputTokens: parsed.usage?.prompt_tokens ?? null,
            outputTokens: parsed.usage?.completion_tokens ?? null,
        };
    } catch {
        // Provider bodies may contain account details; never expose them through errors or logs.
        throw new AppError(
            'AI_UNAVAILABLE',
            combined.aborted
                ? 'AI đã hết thời gian chờ hoặc yêu cầu đã bị hủy. Hãy thử yêu cầu ngắn hơn.'
                : 'Không nhận được kết quả AI hoàn chỉnh. Kiểm tra cấu hình mô hình hoặc thử lại sau.',
        );
    } finally {
        controller.abort();
    }
};
