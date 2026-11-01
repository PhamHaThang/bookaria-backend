import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type pg from 'pg';
import sharp from 'sharp';
import { z } from 'zod';
import type { MediaStorage, StoredFile } from '../lib/cloudinary';
import { decodeSingleMind, MAX_MIND_BYTES } from '../worker/publish/mind';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const publicId = z
    .string()
    .min(1)
    .max(300)
    .regex(/^[a-zA-Z0-9_./-]+$/);
const ManifestSchema = z.object({
    version: z.literal(1),
    count: z.int().positive().max(1000),
    markers: z
        .array(
            z.object({
                id: z.string().min(1).max(100),
                image: z.string().min(1),
                mind: z.string().min(1),
                sha256: checksum,
                mindSha256: checksum,
                markerScore: z.int().min(1).max(5).nullish(),
                imagePublicId: publicId.optional(),
                mindPublicId: publicId.optional(),
            }),
        )
        .min(1)
        .max(1000),
});
export type MarkerSeedFile = {
    path: string;
    publicId: string;
    sha256: string;
    bytes: number;
    resourceType: 'image' | 'raw';
    format: string;
    width: number | null;
    height: number | null;
};
export type MarkerSeed = {
    name: string;
    markerScore: number | null;
    image: MarkerSeedFile;
    mind: MarkerSeedFile;
};

/** Read and validate the entire set before any Cloudinary or database mutation. */
export async function loadMarkerSeedSet(directory: string): Promise<MarkerSeed[]> {
    const root = await realpath(resolve(directory));
    const manifest = ManifestSchema.parse(
        JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')),
    );
    if (manifest.count !== manifest.markers.length)
        throw new Error('Số marker trong manifest không khớp.');
    const names = new Set<string>(),
        images = new Set<string>(),
        minds = new Set<string>();
    const output: MarkerSeed[] = [];
    const local = async (path: string, sha256: string, limit: number) => {
        const absolute = await realpath(resolve(root, path));
        const rel = relative(root, absolute);
        if (
            !rel ||
            rel === '..' ||
            rel.startsWith('../') ||
            rel.startsWith('..\\') ||
            isAbsolute(rel)
        )
            throw new Error(`Tệp nằm ngoài bộ marker: ${path}`);
        const bytes = await readFile(absolute);
        if (!bytes.length || bytes.length > limit || hash(bytes) !== sha256)
            throw new Error(`Tệp rỗng, quá lớn hoặc sai SHA-256: ${path}`);
        return { absolute, bytes };
    };
    for (const marker of manifest.markers) {
        const image = await local(marker.image, marker.sha256, 10 * 1024 * 1024);
        const mind = await local(marker.mind, marker.mindSha256, MAX_MIND_BYTES);
        const meta = await sharp(image.bytes).metadata();
        if (
            !['png', 'jpeg', 'webp'].includes(meta.format) ||
            !meta.width ||
            meta.width !== meta.height ||
            meta.width < 128
        )
            throw new Error(`${marker.id}: ảnh phải vuông, từ 128 px, PNG/JPG/WebP.`);
        const target = decodeSingleMind(mind.bytes);
        if (target.targetImage.width !== target.targetImage.height)
            throw new Error(`${marker.id}: target nhận diện phải vuông.`);
        // Content-addressed IDs remain stable even if the source directory is renamed.
        const imageId = marker.imagePublicId ?? `bookaria/markers/seed/${marker.sha256}/image`;
        const mindId =
            marker.mindPublicId ??
            `bookaria/markers/seed/${marker.sha256}/${marker.mindSha256}.mind`;
        if (names.has(marker.id) || images.has(imageId) || minds.has(mindId))
            throw new Error(`${marker.id}: trùng tên, ảnh hoặc tệp nhận diện trong bộ marker.`);
        names.add(marker.id);
        images.add(imageId);
        minds.add(mindId);
        output.push({
            name: marker.id,
            markerScore: marker.markerScore ?? null,
            image: {
                path: image.absolute,
                publicId: imageId,
                sha256: marker.sha256,
                bytes: image.bytes.length,
                resourceType: 'image',
                format: meta.format === 'jpeg' ? 'jpg' : meta.format,
                width: meta.width,
                height: meta.height,
            },
            mind: {
                path: mind.absolute,
                publicId: mindId,
                sha256: marker.mindSha256,
                bytes: mind.bytes.length,
                resourceType: 'raw',
                format: '',
                width: null,
                height: null,
            },
        });
    }
    return output;
}

function checkStored(file: MarkerSeedFile, remote: StoredFile) {
    if (
        remote.publicId !== file.publicId ||
        remote.bytes !== file.bytes ||
        (file.resourceType === 'image' &&
            (remote.width !== file.width ||
                remote.height !== file.height ||
                remote.format !== file.format))
    )
        throw new Error(`Tệp trên Cloudinary khác tệp seed: ${file.publicId}. Không ghi đè.`);
}
/** Never upload a file which already exists, including a partially completed previous seed. */
export async function ensureMarkerSeedFile(
    file: MarkerSeedFile,
    media: MediaStorage,
    fetchImpl: typeof fetch = fetch,
): Promise<'uploaded' | 'reused'> {
    const existing = await media.inspect(file.resourceType, file.publicId);
    if (existing) {
        checkStored(file, existing);
        return 'reused';
    }
    const bytes = await readFile(file.path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error(`Tệp đã đổi sau khi kiểm tra: ${file.path}`);
    const signature = media.signUpload({
        publicId: file.publicId,
        resourceType: file.resourceType,
        allowedFormats: file.resourceType === 'image' ? [file.format] : [],
        assetFolder: 'bookaria/markers',
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(signature.fields)) form.set(key, String(value));
    const mime =
        file.resourceType === 'raw'
            ? 'application/octet-stream'
            : `image/${file.format === 'jpg' ? 'jpeg' : file.format}`;
    form.set(
        'file',
        new Blob([Uint8Array.from(bytes)], { type: mime }),
        file.publicId.split('/').at(-1),
    );
    try {
        const response = await fetchImpl(signature.uploadUrl, {
            method: 'POST',
            body: form,
            redirect: 'error',
            signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Cloudinary trả HTTP ${response.status}.`);
        }
        const result = z
            .object({
                public_id: z.literal(file.publicId),
                resource_type: z.literal(file.resourceType),
                bytes: z.literal(file.bytes),
            })
            .safeParse(await response.json());
        if (!result.success) throw new Error(`Kết quả tải lên không khớp: ${file.publicId}`);
    } catch (error) {
        // Upload can succeed on the server even when its response is lost.
        const recovered = await media.inspect(file.resourceType, file.publicId);
        if (recovered) {
            checkStored(file, recovered);
            return 'reused';
        }
        throw error;
    }
    const stored = await media.inspect(file.resourceType, file.publicId);
    if (!stored) throw new Error(`Không thấy tệp vừa tải: ${file.publicId}`);
    checkStored(file, stored);
    return 'uploaded';
}

type Existing = { number: number; image_public_id: string; mind_public_id: string };
async function findExisting(db: Pick<pg.PoolClient, 'query'>, marker: MarkerSeed) {
    const found = await db.query<Existing>(
        'SELECT number, image_public_id, mind_public_id FROM bookaria_markers WHERE image_public_id=$1 OR mind_public_id=$2',
        [marker.image.publicId, marker.mind.publicId],
    );
    if (
        found.rows.some(
            (row) =>
                row.image_public_id !== marker.image.publicId ||
                row.mind_public_id !== marker.mind.publicId,
        )
    )
        throw new Error(
            `${marker.name}: ảnh hoặc nhận diện đã đăng ký với cặp khác. Không ghi đè.`,
        );
    return found.rows[0];
}
export async function seedBookariaMarkers(
    db: pg.Pool,
    media: MediaStorage,
    markers: MarkerSeed[],
    report: (message: string) => void = () => {},
    fetchImpl: typeof fetch = fetch,
) {
    const totals = { created: 0, existing: 0, uploaded: 0, reused: 0 };
    // Catch database conflicts for the whole batch before uploading any files.
    for (const marker of markers) await findExisting(db, marker);
    for (const marker of markers) {
        for (const file of [marker.image, marker.mind]) {
            const action = await ensureMarkerSeedFile(file, media, fetchImpl);
            totals[action]++;
            report(
                `${marker.name}: ${action === 'reused' ? 'đã có, bỏ qua tải' : 'đã tải'} ${file.resourceType === 'image' ? 'ảnh' : 'nhận diện'}`,
            );
        }
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            // Same lock as the admin registration endpoint.
            await client.query('SELECT pg_advisory_xact_lock(63112026)');
            const existing = await findExisting(client, marker);
            if (existing) {
                totals.existing++;
                report(`${marker.name}: marker số ${existing.number} đã có, giữ nguyên.`);
            } else {
                const {
                    rows: [next],
                } = await client.query<{ number: string; seed: string }>(
                    'SELECT (COALESCE(MAX(number),0)::bigint+1)::text AS number, (GREATEST(COALESCE(MAX(seed),0),0)+1)::text AS seed FROM bookaria_markers',
                );
                const number = Number(next?.number),
                    seed = Number(next?.seed);
                if (
                    !Number.isSafeInteger(number) ||
                    number > 2147483647 ||
                    !Number.isSafeInteger(seed)
                )
                    throw new Error('Kho marker đã hết mã khả dụng.');
                await client.query(
                    `INSERT INTO bookaria_markers
                    (number, image_public_id, mind_public_id, seed, marker_score, validated_at, is_active)
                    VALUES ($1,$2,$3,$4,$5,now(),true)`,
                    [number, marker.image.publicId, marker.mind.publicId, seed, marker.markerScore],
                );
                totals.created++;
                report(`${marker.name}: đã đăng ký số ${number}, trạng thái bật.`);
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    return totals;
}
