import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkUploadRequest } from '../../../schema';
import { generateModel, ModelStream } from '../runpod';

function fixture(external = false) {
    const json = Buffer.from(
        JSON.stringify({
            meshes: [{}],
            textures: [{}],
            images: [{ bufferView: 0 }],
            buffers: external ? [{ uri: 'https://external.test/buffer.bin' }] : [{ byteLength: 0 }],
        }).padEnd(256),
    );
    const bytes = Buffer.alloc(20 + json.length);
    bytes.write('glTF');
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(json.length, 12);
    bytes.writeUInt32LE(0x4e4f534a, 16);
    json.copy(bytes, 20);
    return {
        bytes,
        events: [
            {
                type: 'file_meta',
                size: bytes.length,
                chunks: 2,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            { type: 'file_chunk', index: 1, data: bytes.subarray(100).toString('base64') },
            { type: 'file_chunk', index: 0, data: bytes.subarray(0, 100).toString('base64') },
            {
                type: 'result',
                action: 'pipeline',
                data: {
                    moderation: { ok: true, is_nsfw: false },
                    texture_moderation: { ok: true, is_nsfw: false },
                },
            },
            { type: 'done' },
        ],
    };
}

describe('Hunyuan streamed model boundary', () => {
    it('accepts out-of-order chunks and identical duplicates after checking SHA-256', () => {
        const { bytes, events } = fixture();
        const stream = new ModelStream();
        for (const event of events) stream.add(event);
        stream.add(events[1]);
        expect(stream.finish()).toEqual(bytes);
    });
    it('rejects missing chunks, conflicting chunks, corrupted hashes and external resources', () => {
        const { events } = fixture();
        const missing = new ModelStream();
        missing.add(events[0]);
        missing.add(events[1]);
        expect(() => missing.finish()).toThrow();
        expect(() => missing.add({ ...events[1], data: 'AAAA' })).toThrow();
        const corrupt = new ModelStream();
        corrupt.add({ ...events[0], sha256: '0'.repeat(64) });
        for (const event of events.slice(1)) corrupt.add(event);
        expect(() => corrupt.finish()).toThrow();
        const external = new ModelStream();
        for (const event of fixture(true).events) external.add(event);
        expect(() => external.finish()).toThrow();
    });
    it('rejects oversized metadata and malformed base64 and sanitizes worker errors', () => {
        const stream = new ModelStream();
        expect(() => stream.add({ ...fixture().events[0], size: 51 * 1024 * 1024 })).toThrow();
        stream.add(fixture().events[0]);
        expect(() => stream.add({ type: 'file_chunk', index: 0, data: '!!!!' })).toThrow();
        expect(() => stream.add({ type: 'error', error: 'secret worker stack trace' })).toThrow(
            'Dịch vụ không tạo được mô hình',
        );
        expect(() => stream.add({ type: 'error', error: 'NSFW detected' })).toThrow(
            'Ảnh không qua bước kiểm tra',
        );
    });
    it('rejects output from a worker that did not confirm moderation', () => {
        const stream = new ModelStream();
        for (const event of fixture().events.filter((event) => event.type !== 'result'))
            stream.add(event);
        expect(() => stream.finish()).toThrow();
    });
    it('uses the moderated textured pipeline and drains the last stream page', async () => {
        const { bytes, events } = fixture();
        const request = vi
            .fn()
            .mockResolvedValueOnce({ id: 'remote-job' })
            .mockResolvedValueOnce({
                status: 'COMPLETED',
                stream: events.map((output) => ({ output })),
            })
            .mockResolvedValueOnce({ status: 'COMPLETED', stream: [] });
        const accepted = vi.fn();
        const result = await generateModel(
            Buffer.from('image'),
            new AbortController().signal,
            accepted,
            vi.fn(),
            request,
        );
        expect(result).toEqual(bytes);
        expect(accepted).toHaveBeenCalledWith('remote-job');
        expect(request.mock.calls[0]?.[2]).toMatchObject({
            input: { action: 'pipeline', texture_resolution: 1024, face_count: 40000 },
        });
        expect(request).toHaveBeenCalledTimes(3);
    });
    it('never resubmits when the paid request response is lost', async () => {
        const request = vi.fn().mockRejectedValue(new Error('connection lost'));
        await expect(
            generateModel(
                Buffer.from('image'),
                new AbortController().signal,
                vi.fn(),
                vi.fn(),
                request,
            ),
        ).rejects.toMatchObject({ code: 'MODEL_GENERATION_INTERRUPTED', retry: false });
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('allows only bounded JPEG/PNG input uploads', () => {
        const input = {
            purpose: 'MODEL_INPUT' as const,
            fileName: 'image.png',
            mimeType: 'image/png',
            sizeBytes: 6 * 1024 * 1024,
        };
        expect(checkUploadRequest(input).ok).toBe(true);
        expect(checkUploadRequest({ ...input, sizeBytes: input.sizeBytes + 1 }).ok).toBe(false);
        expect(checkUploadRequest({ ...input, mimeType: 'image/webp' }).ok).toBe(false);
    });
});
