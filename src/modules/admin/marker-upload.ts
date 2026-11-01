import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../db';
import { getMediaStorage, type MediaStorage } from '../../lib/cloudinary';
import type { Auth } from '../../middlewares';
import {
    BookariaMarkerSchema,
    type ImportBookariaMarkerBody,
    type MarkerUploadBody,
    MarkerUploadResultSchema,
} from '../../schema';
import { AppError } from '../../utils';
import { decodeSingleMind, MAX_MIND_BYTES } from '../../worker/publish/mind';
import { adminRepository } from './admin.repository';
import type { BookariaMarkerRow } from './admin.types';

function storage() {
    const value = getMediaStorage();
    if (!value) throw new AppError('INTERNAL_ERROR', 'Kho tải tệp chưa được cấu hình.');
    return value;
}
export function prepareMarkerUpload(actor: Auth, body: MarkerUploadBody) {
    const media = storage(),
        prefix = `bookaria/markers/uploads/${actor.userId}/${randomUUID()}`;
    const imagePublicId = `${prefix}/image`,
        mindPublicId = `${prefix}/target.mind`;
    const image = media.signUpload({
        publicId: imagePublicId,
        resourceType: 'image',
        allowedFormats: [body.imageFormat],
        assetFolder: 'bookaria/markers',
    });
    const mind = media.signUpload({
        publicId: mindPublicId,
        resourceType: 'raw',
        allowedFormats: [],
        assetFolder: 'bookaria/markers',
    });
    return MarkerUploadResultSchema.parse({
        imagePublicId,
        mindPublicId,
        image: { ...image, expiresAt: image.expiresAt.toISOString() },
        mind: { ...mind, expiresAt: mind.expiresAt.toISOString() },
    });
}
export function markerUploadPrefix(actorId: string, body: ImportBookariaMarkerBody) {
    const base = `bookaria/markers/uploads/${actorId}/`;
    const suffix = body.imagePublicId.slice(base.length);
    const match = /^([a-f0-9-]{36})\/image$/.exec(suffix);
    if (
        !body.imagePublicId.startsWith(base) ||
        !match ||
        body.mindPublicId !== `${base}${match[1]}/target.mind`
    )
        throw new AppError(
            'VALIDATION_ERROR',
            'Phiên tải marker không hợp lệ. Đóng cửa sổ và chọn lại ảnh.',
        );
}
export async function verifyMarkerUpload(
    media: MediaStorage,
    body: ImportBookariaMarkerBody,
    fetchImpl: typeof fetch = fetch,
) {
    const [image, mind] = await Promise.all([
        media.inspect('image', body.imagePublicId),
        media.inspect('raw', body.mindPublicId),
    ]);
    if (!image || !mind)
        throw new AppError(
            'VALIDATION_ERROR',
            'Chưa tải đủ ảnh và tệp nhận diện. Hãy bấm Thử lại.',
        );
    if (
        !image.bytes ||
        image.bytes > 10 * 1024 * 1024 ||
        !['png', 'jpg', 'webp'].includes(image.format) ||
        !image.width ||
        image.width !== image.height ||
        image.width < 128
    )
        throw new AppError(
            'VALIDATION_ERROR',
            'Ảnh marker cần vuông, từ 128 px, là PNG/JPG/WebP và không quá 10 MB.',
        );
    if (!mind.bytes || mind.bytes > MAX_MIND_BYTES)
        throw new AppError(
            'VALIDATION_ERROR',
            'Dữ liệu nhận diện rỗng hoặc vượt 5 MB. Đóng cửa sổ và chọn lại ảnh.',
        );
    const response = await fetchImpl(
        media.deliveryUrl({ resourceType: 'raw', publicId: body.mindPublicId }),
        { redirect: 'error', signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
        await response.body?.cancel();
        throw new AppError('VALIDATION_ERROR', 'Chưa đọc được tệp nhận diện vừa tải. Hãy thử lại.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError('VALIDATION_ERROR', 'Tệp nhận diện không có dữ liệu.');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_MIND_BYTES)
                throw new AppError(
                    'VALIDATION_ERROR',
                    'Dữ liệu nhận diện vượt 5 MB. Hãy chọn ảnh khác.',
                );
            parts.push(part.value);
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    try {
        const target = decodeSingleMind(Buffer.concat(parts));
        if (target.targetImage.width !== target.targetImage.height) throw new Error('shape');
    } catch {
        throw new AppError(
            'VALIDATION_ERROR',
            'Dữ liệu nhận diện không hợp lệ. Đóng cửa sổ và chọn lại ảnh marker.',
        );
    }
}
const columns =
    'id, number, image_public_id, mind_public_id, seed, marker_score, validated_at, is_active';
function dto(row: BookariaMarkerRow) {
    return BookariaMarkerSchema.parse({
        id: row.id,
        number: row.number,
        imageUrl: storage().deliveryUrl({ resourceType: 'image', publicId: row.image_public_id }),
        seed: Number(row.seed),
        markerScore: row.marker_score,
        isActive: row.is_active,
        validatedAt:
            row.validated_at instanceof Date ? row.validated_at.toISOString() : row.validated_at,
    });
}
export async function importUploadedMarker(actor: Auth, body: ImportBookariaMarkerBody) {
    markerUploadPrefix(actor.userId, body);
    const find = async (db: Pick<typeof pool, 'query'>) => {
        const result = await db.query<BookariaMarkerRow>(
            `SELECT ${columns} FROM bookaria_markers WHERE image_public_id=$1 AND mind_public_id=$2`,
            [body.imagePublicId, body.mindPublicId],
        );
        return result.rows[0];
    };
    const existing = await find(pool);
    if (existing) return dto(existing);
    await verifyMarkerUpload(storage(), body);
    const marker = await withTransaction(async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(63112026)');
        const prior = await find(db);
        if (prior) return prior;
        const result = await db.query<{ number: string; seed: string }>(
            'SELECT (COALESCE(MAX(number),0)::bigint+1)::text AS number, (GREATEST(COALESCE(MAX(seed),0),0)+1)::text AS seed FROM bookaria_markers',
        );
        const number = Number(result.rows[0]?.number),
            seed = Number(result.rows[0]?.seed);
        if (!Number.isSafeInteger(number) || number > 2147483647 || !Number.isSafeInteger(seed))
            throw new AppError('VALIDATION_ERROR', 'Kho marker đã hết mã khả dụng.');
        const created = await adminRepository.insertBookariaMarker(db, {
            ...body,
            number,
            seed,
            markerScore: null,
        });
        await adminRepository.insertAuditLog(
            db,
            actor.userId,
            'MANAGE_MARKER',
            created.id,
            { operation: 'CREATE', number, seed, isActive: body.isActive, source: 'UPLOAD' },
            'MARKER',
        );
        return created;
    });
    return dto(marker);
}
