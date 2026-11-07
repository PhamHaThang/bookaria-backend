import { describe, expect, it } from 'vitest';
import { MarkerReportSchema, markerReportStatus } from '../../../schema';
import { markerReportFixture } from '../../../test/marker-report-fixture';
import { checkPublicationMarkers } from '../marker-publish-policy';
import type { CheckInput, CheckPage } from '../publish.types';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const custom = (
    n = 1,
): CheckPage & { image: NonNullable<CheckPage['image']>; markerMindPublicId: string } => {
    const mind = `bookaria/author/page-${n}.mind`,
        image = id(n + 100);
    return {
        id: id(n),
        orderIndex: n - 1,
        markerMode: 'CUSTOM_MARKER',
        markerScore: null,
        markerReport: markerReportFixture(image, mind),
        markerMindPublicId: mind,
        markerJobStatus: null,
        bookariaMarker: null,
        scene: { schemaVersion: 1, objects: [], interactions: [] },
        image: { id: image, status: 'READY', sizeBytes: 100 },
        assets: [],
    };
};
function analyzed(input: unknown) {
    const report = MarkerReportSchema.parse(input);
    if (!report.source || !report.analysis) throw new Error('Fixture needs analyzed source');
    return { ...report, source: report.source, analysis: report.analysis };
}
const input = (...pages: CheckPage[]): CheckInput => ({
    pages,
    pageAspect: Math.SQRT2,
    emailVerified: true,
    takenDown: false,
});
const codes = (pages: CheckPage[]) =>
    checkPublicationMarkers(input(...pages)).errors.map((issue) => issue.code);
describe('technical marker publication policy', () => {
    it('accepts a current validated analysis without an overall score', () => {
        expect(checkPublicationMarkers(input(custom()))).toEqual({ errors: [], warnings: [] });
    });
    it.each(['QUEUED', 'RUNNING'])('blocks an analysis that is %s', (status) => {
        expect(codes([{ ...custom(), markerJobStatus: status }])).toEqual(['MARKER_PROCESSING']);
    });
    it.each(['FAILED', 'CANCELLED'])('blocks an analysis that is %s', (status) => {
        expect(codes([{ ...custom(), markerJobStatus: status }])).toEqual(['MARKER_FAILED']);
    });
    it('blocks missing compilation, absent reports and corrupt reports separately', () => {
        expect(codes([{ ...custom(), markerMindPublicId: null }])).toEqual(['MARKER_MISSING']);
        expect(codes([{ ...custom(), markerReport: null }])).toEqual(['PAGE_NOT_SCORED']);
        expect(codes([{ ...custom(), markerReport: { invalid: true } }])).toEqual([
            'MARKER_INVALID',
        ]);
    });
    it.each([1, 2, 3, 4, 5])(
        'requests new analysis for old reports even when the old score is %i',
        (score) => {
            const report = MarkerReportSchema.parse(custom().markerReport);
            delete report.analysis;
            delete report.source;
            expect(codes([{ ...custom(), markerReport: report, markerScore: score }])).toEqual([
                'MARKER_REANALYZE_REQUIRED',
            ]);
        },
    );
    it('requests new analysis for MindAR reports without proof of the analyzed source', () => {
        const report = MarkerReportSchema.parse(custom().markerReport);
        delete report.source;
        expect(codes([{ ...custom(), markerReport: report }])).toEqual([
            'MARKER_REANALYZE_REQUIRED',
        ]);
    });
    it.each(['image', 'mind', 'aspect'])('blocks a stale %s input', (field) => {
        const page = custom();
        const report = analyzed(page.markerReport);
        if (field === 'image') report.source.imageAssetId = id(999);
        if (field === 'mind') report.source.mindPublicId = 'old.mind';
        if (field === 'aspect') report.source.pageAspect = 1;
        page.markerReport = report;
        expect(codes([page])).toEqual(['MARKER_STALE']);
    });
    it('blocks zero features while keeping low quality as advisory', () => {
        const page = custom(),
            report = analyzed(page.markerReport);
        report.features = 0;
        page.markerReport = report;
        expect(codes([page])).toEqual(['MARKER_NO_FEATURES']);
        report.features = 1;
        report.analysis.distribution = 0.01;
        report.analysis.uniqueness = 0.01;
        report.analysis.sourceWidth = 400;
        const result = checkPublicationMarkers(input(page));
        expect(result.errors).toEqual([]);
        expect(result.warnings.map((warning) => warning.code)).toEqual([
            'MARKER_DISTRIBUTION_LOW',
            'MARKER_UNIQUENESS_LOW',
            'MARKER_IMAGE_SMALL',
        ]);
    });
    it.each(['mind-id', 'compiled-bytes', 'image-pixels'])(
        'blocks an exact duplicate %s with both page ids',
        (kind) => {
            const first = custom(),
                second = custom(2);
            const a = analyzed(first.markerReport),
                b = analyzed(second.markerReport);
            if (kind === 'mind-id') {
                second.markerMindPublicId = first.markerMindPublicId;
                b.source.mindPublicId = first.markerMindPublicId;
            }
            if (kind === 'compiled-bytes') b.source.mindDigest = a.source.mindDigest;
            if (kind === 'image-pixels') b.source.imageDigest = a.source.imageDigest;
            second.markerReport = b;
            const result = checkPublicationMarkers(input(first, second));
            expect(result.errors).toMatchObject([
                { code: 'MARKER_DUPLICATE', pageId: second.id, otherPageId: first.id },
            ]);
            expect(result.errors).toHaveLength(1);
        },
    );
    it('keeps approximate similarity as an acceptible warning, not a duplicate error', () => {
        const first = custom(),
            second = custom(2);
        const report = MarkerReportSchema.parse(first.markerReport);
        report.similarPages = [{ pageId: second.id, similarity: 1 }];
        first.markerReport = report;
        const result = checkPublicationMarkers(input(first, second));
        expect(result.errors).toEqual([]);
        expect(result.warnings).toMatchObject([
            { code: 'PAGE_SIMILAR', pageId: first.id, otherPageId: second.id },
        ]);
    });
    it('does not impose marker analysis on a non-AR page', () => {
        expect(
            checkPublicationMarkers(
                input({
                    ...custom(),
                    markerMode: 'NONE',
                    markerMindPublicId: null,
                    markerReport: null,
                    markerJobStatus: 'FAILED',
                }),
            ),
        ).toEqual({ errors: [], warnings: [] });
    });
    it('checks Bookaria validation, duplicate assignment and physical placement', () => {
        const marker = {
            id: id(80),
            mindPublicId: 'bookaria/markers/80.mind',
            active: true,
            validated: true,
            transform: { x: 0, y: 0, size: 0.22 },
        };
        const page = {
            ...custom(),
            markerMode: 'BOOKARIA_MARKER' as const,
            bookariaMarker: marker,
        };
        expect(codes([page])).toEqual([]);
        expect(codes([{ ...page, bookariaMarker: null }])).toEqual(['MARKER_MISSING']);
        expect(codes([{ ...page, bookariaMarker: { ...marker, validated: false } }])).toEqual([
            'MARKER_INVALID',
        ]);
        expect(codes([{ ...page, bookariaMarker: { ...marker, active: false } }])).toEqual([
            'MARKER_INVALID',
        ]);
        expect(
            codes([
                { ...page, bookariaMarker: { ...marker, transform: { x: 0, y: 0, size: 0.1 } } },
            ]),
        ).toEqual(['MARKER_INVALID']);
        expect(codes([page, { ...page, id: id(2), orderIndex: 1 }])).toEqual(['MARKER_DUPLICATE']);
    });
    it('bounds provenance fields and distinguishes the report states', () => {
        const page = custom();
        expect(
            markerReportStatus(page.markerReport, {
                imageAssetId: page.image.id,
                mindPublicId: page.markerMindPublicId,
                pageAspect: Math.SQRT2,
            }),
        ).toBe('ready');
        const report = analyzed(page.markerReport);
        report.source.mindDigest = 'untrusted';
        expect(MarkerReportSchema.safeParse(report).success).toBe(false);
    });
});
