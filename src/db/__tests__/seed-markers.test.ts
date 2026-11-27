import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from '@msgpack/msgpack';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MediaStorage, StoredFile } from '../../lib/storage';
import type { BookariaMarkerAssessment } from '../../schema/dto.schema';
import { pool } from '..';
import {
    ensureMarkerSeedFile,
    loadMarkerSeedSet,
    type MarkerSeed,
    seedBookariaMarkers,
} from '../seed-markers';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const seedAssessment: BookariaMarkerAssessment = {
    policyVersion: 'mindar-pictarize-v1',
    distribution: 0.7,
    uniqueness: 0.9,
    dimension: 0.5,
    sourceWidth: 128,
    sourceHeight: 128,
    assessedAt: '2026-11-26T07:00:00.000Z',
};
let directory = '',
    markers: MarkerSeed[] = [];
let manifest: {
    version: number;
    count: number;
    markers: {
        id: string;
        image: string;
        mind: string;
        sha256: string;
        mindSha256: string;
        markerScore: number;
        assessment?: BookariaMarkerAssessment;
    }[];
};
beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bookaria-marker-seed-'));
    const entries = [];
    for (let i = 1; i <= 2; i++) {
        const image = await sharp({
            create: {
                width: 128,
                height: 128,
                channels: 3,
                background: i === 1 ? '#ff0000' : '#0000ff',
            },
        })
            .png()
            .toBuffer();
        const mind = encode({
            v: 2,
            dataList: [
                {
                    targetImage: { width: 128, height: 128 },
                    matchingData: [{ id: i }],
                    trackingData: [{}],
                },
            ],
        });
        await writeFile(join(directory, `${i}.png`), image);
        await writeFile(join(directory, `${i}.mind`), mind);
        entries.push({
            id: `SEED-${i}`,
            image: `${i}.png`,
            mind: `${i}.mind`,
            sha256: hash(image),
            mindSha256: hash(mind),
            markerScore: 5,
            ...(i === 1 ? { assessment: seedAssessment } : {}),
        });
    }
    manifest = { version: 1, count: 2, markers: entries };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    markers = await loadMarkerSeedSet(directory);
});
afterAll(async () => {
    if (directory.startsWith(join(tmpdir(), 'bookaria-marker-seed-')))
        await rm(directory, { recursive: true, force: true });
});
function firstMarker() {
    const marker = markers[0];
    if (!marker) throw new Error('Missing test marker');
    return marker;
}
function storage() {
    const files = new Map<string, StoredFile>();
    const descriptors = markers.flatMap((m) => [m.image, m.mind]);
    const key = (type: string, id: string) => `${type}:${id}`;
    const put = (type: string, id: string) => {
        const f = descriptors.find((file) => file.resourceType === type && file.publicId === id);
        if (!f) throw new Error('Unexpected file');
        files.set(key(type, id), {
            publicId: id,
            bytes: f.bytes,
            format: f.format,
            width: f.width,
            height: f.height,
            durationSec: null,
        });
    };
    const media: MediaStorage = {
        async prepareImage(publicId, transform) {
            return this.deliveryUrl({ resourceType: 'image', publicId, transform });
        },
        inspect: vi.fn(async (type, id) => files.get(key(type, id)) ?? null),
        signUpload: vi.fn(({ publicId, resourceType }) => ({
            uploadUrl: `https://account.r2.cloudflarestorage.com/bookaria-test/${resourceType}/upload/${publicId}`,
            method: 'PUT' as const,
            objectKey: publicId,
            headers: { 'If-None-Match': '*' },
            expiresAt: new Date(Date.now() + 60000),
        })),
        async destroy() {
            throw new Error('Seed must not delete files');
        },
        deliveryUrl: ({ publicId }) => `https://example.com/${publicId}`,
    };
    const upload = vi.fn<typeof fetch>(async (url, init) => {
        const type = String(url).includes('/image/') ? 'image' : 'raw';
        const id = new URL(String(url)).pathname.split('/upload/')[1] ?? '';
        expect(init?.method).toBe('PUT');
        expect(((init?.headers ?? {}) as Record<string, string>)['If-None-Match']).toBe('*');
        expect((init?.body as Uint8Array | undefined)?.length).toBe(
            descriptors.find((f) => f.publicId === id)?.bytes,
        );
        put(type, id);
        return new Response(null, { status: 200 });
    });
    return { media, upload, files, put };
}
describe('marker seed files', () => {
    it('validates checksums and generates stable public IDs independently of directory name', async () => {
        expect(await loadMarkerSeedSet(directory)).toEqual(markers);
        expect(markers.every((marker) => !('markerScore' in marker))).toBe(true);
        expect(markers[0]?.image.publicId).toContain(manifest.markers[0]?.sha256);
        expect(markers[0]?.assessment).toEqual(seedAssessment);
        const bad = {
            ...manifest,
            markers: manifest.markers.map((m, i) => (i ? m : { ...m, sha256: '0'.repeat(64) })),
        };
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(bad));
        try {
            await expect(loadMarkerSeedSet(directory)).rejects.toThrow('SHA-256');
        } finally {
            await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
        }
        const escaped = {
            ...manifest,
            markers: manifest.markers.map((m, i) => (i ? m : { ...m, image: '..' })),
        };
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(escaped));
        try {
            await expect(loadMarkerSeedSet(directory)).rejects.toThrow('ngoài bộ marker');
        } finally {
            await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
        }
    });
    it('rejects assessments that describe different image dimensions', async () => {
        const mismatch = {
            ...manifest,
            markers: manifest.markers.map((marker) =>
                marker.assessment
                    ? { ...marker, assessment: { ...marker.assessment, sourceWidth: 256 } }
                    : marker,
            ),
        };
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(mismatch));
        try {
            await expect(loadMarkerSeedSet(directory)).rejects.toThrow('không khớp ảnh gốc');
        } finally {
            await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
        }
    });
    it('does not sign or upload existing R2 files', async () => {
        const s = storage(),
            file = firstMarker().image;
        s.put('image', file.publicId);
        expect(await ensureMarkerSeedFile(file, s.media, s.upload)).toBe('reused');
        expect(s.media.signUpload).not.toHaveBeenCalled();
        expect(s.upload).not.toHaveBeenCalled();
    });
    it('recovers a lost upload response and skips it on the next attempt', async () => {
        const s = storage(),
            file = firstMarker().mind;
        const lost = vi.fn<typeof fetch>(async () => {
            s.put('raw', file.publicId);
            throw new Error('Network disconnected');
        });
        expect(await ensureMarkerSeedFile(file, s.media, lost)).toBe('reused');
        expect(await ensureMarkerSeedFile(file, s.media, lost)).toBe('reused');
        expect(lost).toHaveBeenCalledTimes(1);
    });
    it('does not overwrite mismatched remote files or treat inspection failures as missing files', async () => {
        const s = storage(),
            file = firstMarker().image;
        s.put('image', file.publicId);
        const remote = s.files.get(`image:${file.publicId}`);
        if (!remote) throw new Error('Missing remote test image');
        remote.bytes++;
        await expect(ensureMarkerSeedFile(file, s.media, s.upload)).rejects.toThrow('Không ghi đè');
        vi.mocked(s.media.inspect).mockRejectedValueOnce(new Error('R2 HTTP 429'));
        await expect(ensureMarkerSeedFile(file, s.media, s.upload)).rejects.toThrow('429');
        expect(s.upload).not.toHaveBeenCalled();
    });
    it('rejects local files changed after validation before any upload', async () => {
        const s = storage(),
            file = firstMarker().image,
            bytes = await readFile(file.path);
        await writeFile(file.path, 'changed');
        try {
            await expect(ensureMarkerSeedFile(file, s.media, s.upload)).rejects.toThrow('đã đổi');
        } finally {
            await writeFile(file.path, bytes);
        }
        expect(s.upload).not.toHaveBeenCalled();
    });
});
const dbSuite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
dbSuite('marker seed database integration', () => {
    afterAll(async () => {
        await pool.query('DELETE FROM bookaria_markers WHERE image_public_id=ANY($1::text[])', [
            markers.map((m) => m.image.publicId),
        ]);
    });
    it('resumes a partially uploaded batch and preserves activation and assessment on reseed', async () => {
        const s = storage();
        let failed = false;
        const upload = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).includes('/raw/') && !failed) {
                failed = true;
                throw new Error('temporary upload failure');
            }
            return s.upload(url, init);
        });
        await expect(
            seedBookariaMarkers(pool, s.media, markers, undefined, upload),
        ).rejects.toThrow('temporary upload failure');
        expect(
            (
                await pool.query(
                    'SELECT id FROM bookaria_markers WHERE image_public_id=ANY($1::text[])',
                    [markers.map((m) => m.image.publicId)],
                )
            ).rowCount,
        ).toBe(0);
        const first = await seedBookariaMarkers(pool, s.media, markers, undefined, upload);
        expect(first).toEqual({ created: 2, existing: 0, uploaded: 3, reused: 1 });
        const rows = (
            await pool.query(
                'SELECT * FROM bookaria_markers WHERE image_public_id=ANY($1::text[]) ORDER BY number',
                [markers.map((m) => m.image.publicId)],
            )
        ).rows;
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.is_active === true && r.validated_at)).toBe(true);
        expect(rows.map((row) => row.assessment)).toEqual([seedAssessment, null]);
        const assessment = {
            ...seedAssessment,
            distribution: 0.8,
            assessedAt: '2026-11-26T07:00:00.000Z',
        };
        await pool.query('UPDATE bookaria_markers SET is_active=false, assessment=$2 WHERE id=$1', [
            rows[0].id,
            assessment,
        ]);
        const assessedMarkers = markers.map((marker) => ({
            ...marker,
            assessment: seedAssessment,
        }));
        const count = upload.mock.calls.length;
        const repeats = await Promise.all([
            seedBookariaMarkers(pool, s.media, assessedMarkers, undefined, upload),
            seedBookariaMarkers(pool, s.media, assessedMarkers, undefined, upload),
        ]);
        expect(repeats).toEqual([
            { created: 0, existing: 2, uploaded: 0, reused: 4 },
            { created: 0, existing: 2, uploaded: 0, reused: 4 },
        ]);
        expect(upload.mock.calls).toHaveLength(count);
        expect(
            (await pool.query('SELECT * FROM bookaria_markers WHERE id=$1', [rows[0].id])).rows[0],
        ).toEqual({ ...rows[0], is_active: false, assessment });
        expect(
            (await pool.query('SELECT * FROM bookaria_markers WHERE id=$1', [rows[1].id])).rows[0],
        ).toEqual({ ...rows[1], assessment: seedAssessment });
        // Missing remote file is repaired without changing the database marker.
        s.files.delete(`raw:${firstMarker().mind.publicId}`);
        expect(
            await seedBookariaMarkers(pool, s.media, [firstMarker()], undefined, upload),
        ).toEqual({
            created: 0,
            existing: 1,
            uploaded: 1,
            reused: 1,
        });
    });
    it('does not upload anything when an existing marker uses a conflicting image/mind pair', async () => {
        const s = storage(),
            current = firstMarker();
        const conflict = {
            ...current,
            mind: { ...current.mind, publicId: 'bookaria/markers/conflicting.mind' },
        };
        await expect(
            seedBookariaMarkers(pool, s.media, [conflict], undefined, s.upload),
        ).rejects.toThrow('cặp khác');
        expect(s.media.inspect).not.toHaveBeenCalled();
        expect(s.upload).not.toHaveBeenCalled();
    });
});
