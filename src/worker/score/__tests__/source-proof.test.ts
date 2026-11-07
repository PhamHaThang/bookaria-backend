import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '../../../db';
import type { JobContext } from '../../../modules/jobs/jobs.types';
import { MarkerReportSchema, markerReportStatus } from '../../../schema';
import { createScoreMarkerHandler } from '..';
import { scoreRepository } from '../repo';
import type { MarkerAnalysis, MarkerSnapshot } from '../types';
import { compiledFixture } from './fixtures';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
function fixture(mind = compiledFixture()) {
    const source = {
        id: id(1),
        book_id: id(2),
        image_asset_id: id(3),
        page_aspect: Math.SQRT2,
        marker_mind_public_id: 'bookaria/author/marker.mind',
        original_public_id: 'bookaria/author/image',
        resource_type: 'image',
        format: 'png',
        size_bytes: '100',
        image_status: 'READY',
        image_deleted: false,
    };
    const snapshot: MarkerSnapshot = {
        bookId: id(2),
        ownerId: id(4),
        targetId: id(1),
        pages: [source],
    };
    const repository = {
        ...scoreRepository,
        getMarkerSnapshot: vi.fn(async () => snapshot),
        saveResult: vi.fn<typeof scoreRepository.saveResult>(async () => {}),
    };
    const analysis: MarkerAnalysis = {
        width: 640,
        height: 640,
        png: Buffer.from('png'),
        digest: 'a'.repeat(64),
        points: [],
        descriptors: new Uint8Array(),
        cells: Array(16).fill(0),
        features: 180,
        coverage: 0.8,
        score: 3,
        hints: [],
    };
    const processor = {
        analyze: vi.fn(async () => analysis),
        compare: vi.fn(async () => 0),
        heatmap: vi.fn(async () => Buffer.from('png')),
    };
    const storage = {
        download: vi.fn(async () => Buffer.from('image')),
        downloadMind: vi.fn(async () => mind),
        uploadHeatmap: vi.fn(async () => 'https://example.test/heatmap.png'),
    };
    const commits: Parameters<JobContext['onSuccess']>[0][] = [];
    const context: JobContext = {
        job: {
            id: id(5),
            type: 'SCORE_MARKER',
            status: 'RUNNING',
            ref_type: 'PAGE',
            ref_id: id(1),
            payload: {},
            result: null,
            progress: 0,
            attempts: 1,
            error: null,
            created_by: id(4),
            created_at: new Date(),
            started_at: new Date(),
            finished_at: null,
        },
        signal: new AbortController().signal,
        setProgress: vi.fn(async () => {}),
        onSuccess: (commit) => {
            commits.push(commit);
        },
    };
    return {
        source,
        repository,
        context,
        commits,
        handler: createScoreMarkerHandler(storage, processor, repository),
        storage,
    };
}
describe('marker analysis source proof', () => {
    it('persists the exact image, aspect and downloaded marker fingerprint with independent metrics', async () => {
        const f = fixture();
        expect(await f.handler(f.context)).toEqual({ pageId: id(1), score: null });
        const commit = f.commits[0];
        if (!commit) throw new Error('Expected analysis commit');
        await commit({} as Queryable);
        const report = MarkerReportSchema.parse(f.repository.saveResult.mock.calls[0]?.[3]);
        expect(report.source).toEqual({
            imageAssetId: f.source.image_asset_id,
            mindPublicId: f.source.marker_mind_public_id,
            pageAspect: f.source.page_aspect,
            imageDigest: 'a'.repeat(64),
            mindDigest: createHash('sha256').update(compiledFixture()).digest('hex'),
        });
        expect(report.features).toBe(180);
        expect(
            markerReportStatus(report, {
                imageAssetId: f.source.image_asset_id,
                mindPublicId: f.source.marker_mind_public_id,
                pageAspect: f.source.page_aspect,
            }),
        ).toBe('ready');
    });
    it('never marks a corrupt compilation as successfully analyzed', async () => {
        const f = fixture(Buffer.from('corrupt'));
        await expect(f.handler(f.context)).rejects.toMatchObject({ code: 'INVALID_MIND' });
        expect(f.commits).toEqual([]);
        expect(f.storage.uploadHeatmap).not.toHaveBeenCalled();
    });
});
