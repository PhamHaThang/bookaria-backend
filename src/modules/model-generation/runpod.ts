import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { env } from '../../config';
import { JobError } from '../jobs/jobs.types';

const MAX_GLB = 50 * 1024 * 1024;
const id = z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(200);
const metaSchema = z.object({
    size: z.int().positive().max(MAX_GLB),
    chunks: z.int().positive().max(100),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const invalid = () =>
    new JobError('INVALID_MODEL', 'Dịch vụ trả về mô hình không đầy đủ hoặc không hợp lệ.');

/** The worker streams binary chunks; verify the complete file before it enters the library. */
export class ModelStream {
    private meta: z.infer<typeof metaSchema> | undefined;
    private chunks = new Map<number, Buffer>();
    private size = 0;
    private done = false;
    private moderated = false;

    add(input: unknown) {
        const event = z.record(z.string(), z.unknown()).parse(input);
        if (event.type === 'error' || event.error) {
            throw new JobError(
                'MODEL_GENERATION_FAILED',
                /nsfw|not.safe|unsafe|inappropriate/i.test(String(event.error))
                    ? 'Ảnh không qua bước kiểm tra nội dung. Hãy chọn ảnh khác.'
                    : 'Dịch vụ không tạo được mô hình. Hãy kiểm tra ảnh đầu vào và worker RunPod.',
            );
        }
        if (event.type === 'result' && event.action === 'pipeline') {
            const verdict = z.object({ ok: z.literal(true), is_nsfw: z.literal(false) });
            z.object({
                moderation: verdict,
                texture_moderation: z.union([verdict, verdict.array().min(1)]),
            }).parse(event.data);
            this.moderated = true;
        } else if (event.type === 'file_meta') {
            const meta = metaSchema.parse(event);
            if (this.meta && JSON.stringify(meta) !== JSON.stringify(this.meta)) throw invalid();
            this.meta = meta;
        } else if (event.type === 'file_chunk') {
            const index = z.int().nonnegative().parse(event.index);
            const data = z.string().min(4).max(1_000_000).parse(event.data);
            if (
                !this.meta ||
                index >= this.meta.chunks ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
            )
                throw invalid();
            const bytes = Buffer.from(data, 'base64');
            const previous = this.chunks.get(index);
            if (previous) {
                if (!previous.equals(bytes)) throw invalid();
                return;
            }
            this.size += bytes.length;
            if (this.size > this.meta.size) throw invalid();
            this.chunks.set(index, bytes);
        } else if (event.type === 'done') this.done = true;
    }

    finish() {
        if (!this.done || !this.moderated || !this.meta || this.chunks.size !== this.meta.chunks)
            throw invalid();
        const bytes = Buffer.concat(
            Array.from(
                { length: this.meta.chunks },
                (_, index) => this.chunks.get(index) as Buffer,
            ),
        );
        if (
            bytes.length !== this.meta.size ||
            createHash('sha256').update(bytes).digest('hex') !== this.meta.sha256
        )
            throw invalid();
        if (
            bytes.length < 20 ||
            bytes.toString('ascii', 0, 4) !== 'glTF' ||
            bytes.readUInt32LE(4) !== 2 ||
            bytes.readUInt32LE(8) !== bytes.length ||
            bytes.readUInt32LE(16) !== 0x4e4f534a
        )
            throw invalid();
        const end = 20 + bytes.readUInt32LE(12);
        if (end > bytes.length) throw invalid();
        const model = z
            .object({
                meshes: z.array(z.unknown()).min(1),
                textures: z.array(z.unknown()).min(1),
                images: z.array(z.object({ uri: z.string().optional() })).min(1),
                buffers: z.array(z.object({ uri: z.string().optional() })).default([]),
            })
            .parse(JSON.parse(bytes.toString('utf8', 20, end)));
        if ([...model.images, ...model.buffers].some(({ uri }) => uri && !uri.startsWith('data:')))
            throw invalid();
        return bytes;
    }
}

export function requireModelService() {
    if (!env.RUNPOD_MODEL_API_KEY || !env.RUNPOD_MODEL_ENDPOINT_ID) {
        throw new JobError('MODEL_UNAVAILABLE', 'Chưa cấu hình dịch vụ tạo mô hình 3D.');
    }
}

export async function runpodRequest(
    path: string,
    signal: AbortSignal,
    body?: object,
    network = fetch,
): Promise<Record<string, unknown>> {
    requireModelService();
    const response = await network(
        `https://api.runpod.ai/v2/${env.RUNPOD_MODEL_ENDPOINT_ID}/${path}`,
        {
            method: body ? 'POST' : 'GET',
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${env.RUNPOD_MODEL_API_KEY}`,
                ...(body && { 'Content-Type': 'application/json' }),
            },
            ...(body && { body: JSON.stringify(body) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
    );
    if (!response.ok) {
        await response.body?.cancel();
        throw new JobError(
            'MODEL_PROVIDER_ERROR',
            `Không kết nối được dịch vụ tạo 3D (HTTP ${response.status}).`,
        );
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 75 * 1024 * 1024) throw invalid();
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
    }
    return z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function cancelModel(remoteId: string) {
    await runpodRequest(`cancel/${id.parse(remoteId)}`, AbortSignal.timeout(10_000), {}).catch(
        () => {},
    );
}

export async function generateModel(
    image: Buffer,
    signal: AbortSignal,
    accepted: (remoteId: string) => Promise<void>,
    progress: (percent: number) => Promise<void>,
    request = runpodRequest,
) {
    let remoteId: string | undefined;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(31 * 60_000)]);
    try {
        // Never retry this POST: a lost response may already represent a paid GPU job.
        const submitted = await request('run', deadline, {
            input: {
                action: 'pipeline',
                image_base64: image.toString('base64'),
                texture_resolution: 1024,
                face_count: 40000,
            },
            policy: { executionTimeout: 1200000, ttl: 1800000 },
        });
        remoteId = id.parse(submitted.id);
        await accepted(remoteId);
        const stream = new ModelStream();
        const stages: Record<string, number> = {
            moderation: 15,
            'generate3d.preprocess': 20,
            'generate3d.shape_generation': 35,
            'generate3d.mesh_cleanup': 55,
            'generate3d.loading_texture_pipeline': 60,
            'generate3d.texture_generation': 65,
            'generate3d.texture_completed': 80,
            'generate3d.glb_export': 85,
        };
        for (;;) {
            const state = await request(`stream/${remoteId}`, deadline);
            if (
                state.error ||
                ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(state.status))
            ) {
                throw new JobError(
                    'MODEL_GENERATION_FAILED',
                    'Tạo 3D không thành công hoặc đã quá thời gian chờ. Hãy kiểm tra worker RunPod.',
                );
            }
            const entries = z
                .array(z.object({ output: z.unknown() }))
                .max(500)
                .parse(state.stream ?? []);
            for (const entry of entries) {
                stream.add(entry.output);
                const event = z.record(z.string(), z.unknown()).parse(entry.output);
                if (event.type === 'progress') await progress(stages[String(event.stage)] ?? 5);
                if (event.type === 'result' && event.action === 'pipeline') await progress(15);
                if (event.type === 'file_meta') await progress(90);
            }
            if (state.status === 'COMPLETED' && entries.length === 0) return stream.finish();
            await delay(2000, undefined, { signal: deadline });
        }
    } catch (error) {
        if (remoteId) await cancelModel(remoteId);
        if (error instanceof JobError) throw error;
        throw new JobError(
            'MODEL_GENERATION_INTERRUPTED',
            remoteId
                ? 'Quá trình tạo 3D bị gián đoạn. Không tự động gửi lại để tránh tính phí hai lần.'
                : 'Chưa xác nhận được tác vụ từ RunPod. Kiểm tra RunPod trước khi tạo lại để tránh tính phí hai lần.',
        );
    }
}
