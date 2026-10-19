import { env } from '../../config';
import { pool } from '../../db';
import { parseCloudinaryUrl } from '../../lib/cloudinary';
import { JobError, type JobHandler } from '../../modules/jobs/jobs.types';
import { JobResultsSchema, MarkerReportSchema } from '../../schema';
import { scoreRepository } from './repo';
import { createMarkerStorage, type MarkerStorage } from './storage';
import type { MarkerSource, PeerComparison } from './types';
import { analyzeMarker, markerSimilarity, renderHeatmap, SCORE_POLICY } from './vision';

const vision = { analyze: analyzeMarker, compare: markerSimilarity, heatmap: renderHeatmap };

export function createScoreMarkerHandler(
    storage: MarkerStorage,
    processor: typeof vision = vision,
    repository: typeof scoreRepository = scoreRepository,
): JobHandler {
    return async (ctx) => {
        // Kiểm tra Job có hợp lệ không?
        if (ctx.job.ref_type !== 'PAGE')
            throw new JobError('INVALID_REFERENCE', 'Tác vụ không tham chiếu trang.');
        ctx.signal.throwIfAborted();

        // Lấy thông tin snapshot của marker Custom
        const snapshot = await repository.getMarkerSnapshot(pool, ctx.job);
        const target = snapshot.pages.find((p) => p.id === snapshot.targetId);
        if (!target) throw new JobError('PAGE_NOT_FOUND', 'Không tìm thấy trang Custom.');

        // Phân tích marker Custom chính
        async function analyze(page: MarkerSource) {
            if (
                page.resource_type !== 'image' ||
                page.image_status !== 'READY' ||
                page.image_deleted
            ) {
                throw new JobError(
                    'INVALID_PAGE_IMAGE',
                    'Ảnh của một trang Custom không còn sẵn sàng.',
                );
            }
            return processor.analyze(await storage.download(page, ctx.signal), ctx.signal);
        }
        await ctx.setProgress(5);
        const result = await analyze(target);
        await ctx.setProgress(20);

        // So sánh với các trang marker Custom khác trong sách
        const others = snapshot.pages.filter((p) => p.id !== target.id);
        const comparisons: PeerComparison[] = [];
        for (const [index, peer] of others.entries()) {
            ctx.signal.throwIfAborted();
            const analyzed = await analyze(peer);
            comparisons.push({
                pageId: peer.id,
                features: analyzed.features,
                coverage: analyzed.coverage,
                hints: analyzed.hints,
                similarity: await processor.compare(result, analyzed, ctx.signal),
            });
            await ctx.setProgress(20 + Math.round((60 * (index + 1)) / others.length));
        }
        // Render heatmap và lưu kết quả chấm điểm
        const png = await processor.heatmap(result, ctx.signal);
        const publicId = `bookaria/marker-reports/${target.id}/${ctx.job.id}-${ctx.job.attempts}`;
        const heatmapUrl = await storage.uploadHeatmap(publicId, png, ctx.signal);
        const report = MarkerReportSchema.parse({
            features: result.features,
            coverage: result.coverage,
            heatmapUrl,
            similarPages: comparisons
                .filter((p) => p.similarity >= SCORE_POLICY.similarThreshold)
                .map(({ pageId, similarity }) => ({ pageId, similarity })),
            hints: result.hints,
        });
        ctx.signal.throwIfAborted();
        await ctx.setProgress(95);
        ctx.onSuccess((db) =>
            repository.saveResult(db, snapshot, result.score, report, comparisons),
        );
        return JobResultsSchema.SCORE_MARKER.parse({ pageId: target.id, score: result.score });
    };
}

export const scoreMarkerHandler: JobHandler = async (ctx) => {
    if (!env.CLOUDINARY_URL)
        throw new JobError('STORAGE_NOT_CONFIGURED', 'Chưa cấu hình kho ảnh marker.', true);
    return createScoreMarkerHandler(createMarkerStorage(parseCloudinaryUrl(env.CLOUDINARY_URL)))(
        ctx,
    );
};
