import { z } from 'zod';

export const PICTARIZE_POLICY = 'mindar-pictarize-v1' as const;
const DimensionSchema = z.number().int().positive().max(16384);
const RatioSchema = z.number().finite().min(0).max(1);
export const MarkerAnalysisMetricsSchema = z.object({
    policyVersion: z.literal(PICTARIZE_POLICY),
    distribution: RatioSchema,
    uniqueness: RatioSchema,
    dimension: RatioSchema,
    sourceWidth: DimensionSchema,
    sourceHeight: DimensionSchema,
});
export type MarkerAnalysisMetrics = z.infer<typeof MarkerAnalysisMetricsSchema>;

const FeatureSchema = z.object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    scale: z.number().finite().nonnegative().max(32).default(0),
    descriptors: z.array(z.number().int().min(0).max(0xffffffff)).length(21),
});
export const MindarMatchingLevelSchema = z.object({
    width: DimensionSchema,
    height: DimensionSchema,
    maximaPoints: z.array(FeatureSchema).max(2048),
    minimaPoints: z.array(FeatureSchema).max(2048),
});

export const MarkerImageAnalysisSchema = z.object({
    algorithm: z.literal('MindAR'),
    analysis: MarkerAnalysisMetricsSchema,
    features: z.number().int().nonnegative().max(4096),
    coverage: RatioSchema,
    width: DimensionSchema,
    height: DimensionSchema,
    cells: z.array(z.number().int().nonnegative()).length(100),
    points: z.array(FeatureSchema.omit({ descriptors: true })).max(4096),
    hints: z.array(z.string()),
});
export type MarkerImageAnalysis = z.infer<typeof MarkerImageAnalysisSchema>;
export const MarkerImagePreviewSchema = MarkerImageAnalysisSchema.extend({
    image: z
        .string()
        .startsWith('data:image/png;base64,')
        .max(6 * 1024 * 1024),
});
export type MarkerImagePreview = z.infer<typeof MarkerImagePreviewSchema>;

const bitCount = (value: number): number => {
    let bits = value - ((value >>> 1) & 0x55555555);
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
    return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Pictarize compares FREAK descriptors within each polarity, with distance < 50. */
export function analyzeMindarLevel(
    input: unknown,
    sourceWidth: number,
    sourceHeight: number,
    signal?: AbortSignal,
): MarkerImageAnalysis {
    signal?.throwIfAborted();
    const level = MindarMatchingLevelSchema.parse(input);
    const width = DimensionSchema.parse(sourceWidth);
    const height = DimensionSchema.parse(sourceHeight);
    const points = [...level.maximaPoints, ...level.minimaPoints];
    const cells = Array<number>(100).fill(0);
    for (const point of points) {
        if (point.x >= level.width || point.y >= level.height)
            throw new Error('Feature coordinates are outside the target image');
        const cell =
            Math.floor((point.y / level.height) * 10) * 10 +
            Math.floor((point.x / level.width) * 10);
        cells[cell] = (cells[cell] ?? 0) + 1;
    }
    let repeated = 0;
    for (const group of [level.maximaPoints, level.minimaPoints]) {
        for (let i = 0; i < group.length; i++) {
            if (i % 32 === 0) signal?.throwIfAborted();
            const feature = group[i];
            if (!feature) continue;
            for (let j = 0; j < group.length; j++) {
                const candidate = group[j];
                if (i === j || !candidate) continue;
                let distance = 0;
                for (let word = 0; word < 21 && distance < 50; word++) {
                    distance += bitCount(
                        (feature.descriptors[word] ?? 0) ^ (candidate.descriptors[word] ?? 0),
                    );
                }
                if (distance < 50) {
                    repeated++;
                    break;
                }
            }
        }
    }
    const distribution = cells.filter((count) => count > 0).length / 100;
    // Empty targets get a finite zero instead of Pictarize's 0/0.
    const uniqueness = points.length ? 1 - repeated / points.length : 0;
    const short = Math.min(width, height);
    const ratio = short / Math.max(width, height);
    const resolution = [200, 400, 600, 800, 1000].filter((limit) => short >= limit).length;
    // Preserve the shipped Pictarize thresholds, including its unreachable aspect score 4.
    const aspect = ratio >= 0.8 ? 5 : ratio >= 0.6 ? 3 : ratio >= 0.4 ? 2 : ratio >= 0.2 ? 1 : 0;
    const dimension = (resolution + aspect) / 10;
    const hints: string[] = [];
    if (!points.length)
        hints.push('Không tìm thấy điểm đặc trưng. Hãy chọn ảnh có chi tiết và tương phản rõ.');
    if (distribution < 0.5)
        hints.push(
            'Điểm đặc trưng tập trung ở ít vùng; hạn chế khoảng trống lớn, nhất là ở rìa ảnh.',
        );
    if (uniqueness < 0.5)
        hints.push('Nhiều điểm đặc trưng giống nhau; tránh họa tiết lặp và bố cục đối xứng.');
    if (short < 1000) hints.push('Nên dùng ảnh gốc có mỗi chiều từ 1000 px.');
    if (ratio < 0.8)
        hints.push(
            'Ảnh gần vuông được đánh giá kích thước cao hơn; tránh tỷ lệ quá dài hoặc quá hẹp.',
        );
    return {
        algorithm: 'MindAR',
        analysis: {
            policyVersion: PICTARIZE_POLICY,
            distribution,
            uniqueness,
            dimension,
            sourceWidth: width,
            sourceHeight: height,
        },
        features: points.length,
        coverage: distribution,
        width: level.width,
        height: level.height,
        cells,
        points: points.map(({ x, y, scale }) => ({ x, y, scale })),
        hints,
    };
}
