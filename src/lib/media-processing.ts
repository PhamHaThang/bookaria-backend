import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { z } from 'zod';
import { env } from '../config';
import { AppError } from '../utils/api-error';

const run = promisify(execFile);
async function withInput<T>(
    bytes: Uint8Array,
    action: (file: string, directory: string) => Promise<T>,
) {
    const directory = await mkdtemp(join(tmpdir(), 'bookaria-media-'));
    try {
        const file = join(directory, 'input');
        await writeFile(file, bytes);
        return await action(file, directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
export async function probeMedia(bytes: Uint8Array, signal?: AbortSignal) {
    return withInput(bytes, async (file) => {
        let stdout: string;
        try {
            ({ stdout } = await run(
                env.FFPROBE_PATH || ffprobe.path,
                [
                    '-v',
                    'error',
                    '-protocol_whitelist',
                    'file,pipe',
                    '-show_format',
                    '-show_streams',
                    '-of',
                    'json',
                    file,
                ],
                { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, signal },
            ));
        } catch (error) {
            // Only ffprobe's invalid-input exit is a rejected upload; aborts/timeouts/missing binaries keep the original.
            if (
                error instanceof Error &&
                'code' in error &&
                error.code === 1 &&
                !('killed' in error && error.killed)
            ) {
                throw new AppError(
                    'FILE_TYPE_NOT_ALLOWED',
                    'Không đọc được âm thanh/video. Hãy chọn tệp MP3, WAV hoặc MP4 hợp lệ.',
                );
            }
            throw error;
        }
        const data = z
            .object({
                format: z.object({
                    format_name: z.string(),
                    duration: z.coerce.number().positive().finite(),
                }),
                streams: z.array(
                    z.object({
                        codec_type: z.string(),
                        width: z.number().int().positive().optional(),
                        height: z.number().int().positive().optional(),
                    }),
                ),
            })
            .safeParse(JSON.parse(stdout));
        if (!data.success)
            throw new AppError(
                'FILE_TYPE_NOT_ALLOWED',
                'Không đọc được thời lượng hoặc nội dung âm thanh/video. Hãy chọn tệp hợp lệ.',
            );
        const metadata = data.data;
        const video = metadata.streams.find((stream) => stream.codec_type === 'video');
        const format = metadata.format.format_name
            .split(',')
            .find((name) => ['mp3', 'wav', 'mp4'].includes(name));
        if (
            !format ||
            !metadata.streams.some((stream) => ['audio', 'video'].includes(stream.codec_type))
        )
            throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Tệp audio/video không được hỗ trợ.');
        return {
            format,
            duration: metadata.format.duration,
            width: video?.width ?? null,
            height: video?.height ?? null,
        };
    });
}
export async function videoThumbnail(bytes: Uint8Array, signal: AbortSignal) {
    return withInput(bytes, async (file, directory) => {
        const output = join(directory, 'thumbnail.jpg');
        await run(
            env.FFMPEG_PATH || ffmpeg || 'ffmpeg',
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-protocol_whitelist',
                'file,pipe',
                '-i',
                file,
                '-frames:v',
                '1',
                '-vf',
                'scale=320:320:force_original_aspect_ratio=decrease',
                '-threads',
                '1',
                output,
            ],
            { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, signal },
        );
        return readFile(output);
    });
}
