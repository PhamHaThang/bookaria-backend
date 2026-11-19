import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { env } from '../../../config';
import type { AssetRow } from '../../../modules/assets/assets.types';
import { silentWav } from '../../../test/media';
import { account, fakeR2 } from '../../../test/r2';
import { createProcessingStorage } from '../storage';

const asset = {
    id: 'test',
    original_public_id: 'bookaria/a',
    resource_type: 'video',
    type: 'AUDIO',
    format: 'wav',
} as AssetRow;
const signal = () => new AbortController().signal;
describe('R2 processing storage', () => {
    it('keeps missing ffprobe binaries distinct from invalid media', async () => {
        const fake = fakeR2();
        fake.files.set('bookaria/a', { bytes: silentWav(), type: 'audio/wav', format: 'wav' });
        const before = env.FFPROBE_PATH;
        env.FFPROBE_PATH = `${process.cwd()}/missing-ffprobe-executable`;
        try {
            await expect(
                createProcessingStorage(account, fake.network).inspect(asset, signal()),
            ).rejects.toMatchObject({ code: 'ENOENT' });
            expect(fake.files.has('bookaria/a')).toBe(true);
        } finally {
            env.FFPROBE_PATH = before;
        }
    });

    it('reads real WAV duration and omits nonexistent image dimensions', async () => {
        const fake = fakeR2();
        fake.files.set('bookaria/a', { bytes: silentWav(), type: 'audio/wav', format: 'wav' });
        expect(
            await createProcessingStorage(account, fake.network).inspect(asset, signal()),
        ).toEqual({ bytes: 8044, format: 'wav', duration: 0.5 });
    });
    it('rejects empty or corrupt audio and missing files', async () => {
        const fake = fakeR2(),
            storage = createProcessingStorage(account, fake.network);
        await expect(storage.inspect(asset, signal())).rejects.toThrow();
        for (const bytes of [new Uint8Array(), Buffer.from('bad audio')]) {
            fake.files.set('bookaria/a', { bytes, type: 'audio/wav', format: 'wav' });
            await expect(storage.inspect(asset, signal())).rejects.toThrow();
        }
    });
    it('reads real video dimensions and generates a JPEG thumbnail locally', async () => {
        assert(ffmpeg);
        const { stdout } = await promisify(execFile)(
            ffmpeg,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=c=red:s=64x48:d=0.2',
                '-c:v',
                'mpeg4',
                '-f',
                'mp4',
                '-movflags',
                'frag_keyframe+empty_moov',
                'pipe:1',
            ],
            { encoding: 'buffer', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
        );
        const fake = fakeR2();
        fake.files.set('bookaria/a', { bytes: stdout, type: 'video/mp4', format: 'mp4' });
        const storage = createProcessingStorage(account, fake.network),
            video = { ...asset, type: 'VIDEO' as const };
        const stored = await storage.inspect(video, signal());
        expect(stored).toMatchObject({
            format: 'mp4',
            width: 64,
            height: 48,
            duration: 0.2,
        });
        const url = await storage.thumbnail(video, signal(), stored.source);
        const downloads = fake.network.mock.calls.filter(
            ([request]) =>
                request instanceof Request &&
                request.method === 'GET' &&
                request.url.endsWith('/bookaria/a'),
        );
        expect(downloads).toHaveLength(1);
        expect(url).toBe('https://assets.bookaria.test/bookaria/thumbnails/test.jpg');
        const thumbnail = fake.files.get('bookaria/thumbnails/test.jpg');
        assert(thumbnail);
        expect(await sharp(thumbnail.bytes).metadata()).toMatchObject({
            format: 'jpeg',
            width: 320,
            height: 240,
        });
    });
    it('uploads optimized GLB bytes without changing their key or allowing overwrite', async () => {
        const fake = fakeR2(),
            storage = createProcessingStorage(account, fake.network);
        await storage.uploadModel('bookaria/model', new Uint8Array([1, 2, 3]), signal());
        expect(fake.files.get('bookaria/model')?.format).toBe('glb');
        await expect(
            storage.uploadModel('bookaria/model', new Uint8Array([4]), signal()),
        ).rejects.toThrow('ghi đè');
    });
});
