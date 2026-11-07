import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decode, encode } from '@msgpack/msgpack';
import { z } from 'zod';
import { JobError } from '../../modules/jobs/jobs.types';
import { MB } from '../../schema';

export const MAX_MIND_BYTES = 5 * MB;
export const MAX_OUTPUT_BYTES = 9_000_000;

const TargetSchema = z.looseObject({
    targetImage: z.looseObject({
        width: z.int().positive().max(16384),
        height: z.int().positive().max(16384),
    }),
    matchingData: z.array(z.unknown()).min(1).max(64),
    trackingData: z.array(z.unknown()).min(1).max(64),
});

const SingleMindSchema = z.object({ v: z.literal(2), dataList: z.array(TargetSchema).length(1) });
export type MindTarget = z.infer<typeof TargetSchema>;

/**
 * Đọc một file .mind
 */
export function decodeSingleMind(bytes: Uint8Array): MindTarget {
    // Kiểm tra dung lượng
    if (!bytes.byteLength || bytes.byteLength > MAX_MIND_BYTES) {
        throw new JobError('MIND_SIZE', 'Mỗi .mind phải có dữ liệu và không quá 5 MiB.');
    }
    try {
        // Giải mã MessagePack
        const decoded = decode(bytes, {
            maxArrayLength: 200_000,
            maxMapLength: 1024,
            maxStrLength: 1_000_000,
            maxBinLength: MAX_MIND_BYTES,
        });
        // Kiểm tra Schema và lấy Target
        return SingleMindSchema.parse(decoded).dataList[0] as MindTarget;
    } catch {
        throw new JobError(
            'INVALID_MIND',
            'Cần .mind MessagePack v2, đúng một target, có matchingData/trackingData. Hãy biên dịch lại bằng MindAR 1.2.5.',
        );
    }
}

/** Revalidate actual downloaded bytes before adding a target to a publication. */
export function readPublicationMind(
    bytes: Uint8Array,
    expectedDigest: string | undefined,
    seen: Set<string>,
): MindTarget {
    const target = decodeSingleMind(bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (expectedDigest !== undefined && expectedDigest !== digest)
        throw new JobError(
            'MARKER_STALE',
            'Tệp marker đã thay đổi sau khi phân tích. Đánh giá lại ảnh nhận diện rồi xuất bản lại.',
        );
    if (seen.has(digest))
        throw new JobError(
            'MARKER_DUPLICATE',
            'Hai trang dùng cùng tệp marker. Chọn marker khác rồi xuất bản lại.',
        );
    seen.add(digest);
    return target;
}

/**
 * Ghép nhiều Marker thành group
 */
export function encodeGroup(targets: MindTarget[]): Buffer {
    if (targets.length < 1 || targets.length > 10) {
        throw new JobError('MIND_GROUP_SIZE', 'Nhóm cần từ 1 đến 10 trang AR.');
    }
    return Buffer.from(encode({ v: 2, dataList: targets }));
}

/**
 * Nén dữ liệu
 */
export function compressGroup(bytes: Buffer): Buffer {
    return gzipSync(bytes, { level: 9 });
}
