import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type cvTypes from '@techstark/opencv-js';
import sharp, { type OutputInfo } from 'sharp';
import { JobError } from '../../modules/jobs/jobs.types';
import { MB } from '../../schema';
import type { MarkerAnalysis, Match, Point } from './types';

export const SCORE_POLICY = {
    version: 'orb-4.12-grid-v1-provisional',
    maxBytes: 10 * 1024 * 1024,
    maxPixels: 16_777_216,
    maxSide: 1024,
    maxFeatures: 1200,
    similarThreshold: 0.35,
    minInliers: 12,
    ratio: 0.75,
} as const;

let ready: Promise<{ cv: typeof cvTypes }> | undefined;
const require = createRequire(import.meta.url);
/**
 * Lấy module OpenCV đã được load và sẵn sàng sử dụng. Nếu chưa load thì sẽ load module này.
 */
export function getOpenCv() {
    ready ??= new Promise<{ cv: typeof cvTypes }>((resolve) => {
        const module = require('@techstark/opencv-js') as typeof cvTypes;
        if (module.Mat) resolve({ cv: module });
        else module.onRuntimeInitialized = () => resolve({ cv: module });
    });
    return ready;
}

/**
 * Chia ảnh thành 16 vùng và đếm số điểm trong mỗi vùng.
 */
export function gridCounts(points: Point[], width: number, height: number): number[] {
    const cells = Array<number>(16).fill(0);
    for (const point of points) {
        const x = Math.min(3, Math.max(0, Math.floor((point.x / width) * 4)));
        const y = Math.min(3, Math.max(0, Math.floor((point.y / height) * 4)));
        const index = y * 4 + x;
        cells[index] = (cells[index] ?? 0) + 1;
    }
    return cells;
}

/**
 * Chấm điểm dựa trên số lượng đặc trưng và độ phủ của các đặc trưng.
 * @param features Số điểm đặc trưng tìm được bằng ORB
 * @param coverage Độ phủ của các đặc trưng, là tỷ lệ số ô có ít nhất một đặc trưng trên tổng số ô (16 ô)
 * @returns Điểm chấm từ 1 đến 5 sao, dựa trên số lượng đặc trưng và độ phủ.
 */
export function starScore(features: number, coverage: number): number {
    if (features >= 500 && coverage >= 14 / 16) return 5;
    if (features >= 250 && coverage >= 12 / 16) return 4;
    if (features >= 100 && coverage >= 8 / 16) return 3;
    if (features >= 40 && coverage >= 4 / 16) return 2;
    return 1;
}

/**
 * Tạo ra các gợi ý để cải thiện chất lượng ảnh dựa trên số lượng đặc trưng và độ phủ.
 * @param features Số điểm đặc trưng tìm được bằng ORB
 * @param coverage Độ phủ của các đặc trưng, là tỷ lệ số ô có ít nhất một đặc trưng trên tổng số ô (16 ô)
 * @returns Mảng các gợi ý để cải thiện chất lượng ảnh.
 */
export function scoreHints(features: number, coverage: number): string[] {
    const hints = ['Điểm tham khảo; ngưỡng chưa được hiệu chuẩn với bộ ảnh sách thật.'];

    if (features < 100) {
        hints.push('Chọn ảnh nhiều chi tiết, tăng tương phản và tránh ảnh bị mờ.');
    }

    if (coverage < 0.5) {
        hints.push('Phân bố chi tiết sang các vùng trống được tô đỏ trên ảnh.');
    }

    if (starScore(features, coverage) < 3) {
        hints.push(
            'Thử ảnh chi tiết hơn; hoặc dùng marker Bookaria; hoặc đánh dấu trang không có AR.',
        );
    }

    return hints;
}

/**
 * Phân tích một ảnh marker, trả về các thông tin về đặc trưng, độ phủ, điểm chấm và gợi ý.
 * @param input Ảnh marker dưới dạng Uint8Array
 * @param signal Tín hiệu hủy bỏ để dừng phân tích nếu cần
 * @returns Thông tin phân tích marker
 */
export async function analyzeMarker(
    input: Uint8Array,
    signal: AbortSignal,
): Promise<MarkerAnalysis> {
    signal.throwIfAborted();
    // Kiểm tra dung lượng và định dạng ảnh.
    if (!input.byteLength || input.byteLength > SCORE_POLICY.maxBytes) {
        throw new JobError(
            'INVALID_IMAGE_SIZE',
            `Ảnh marker phải có dữ liệu và không quá ${SCORE_POLICY.maxBytes / MB} MB.`,
        );
    }

    let normalized: { data: Buffer; info: OutputInfo };
    try {
        // Chuẩn hóa ảnh bằng Sharp
        const image = sharp(input, { limitInputPixels: SCORE_POLICY.maxPixels, failOn: 'warning' });
        const metadata = await image.metadata();
        // Kiểm tra định dạng ảnh
        if (
            !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') ||
            (metadata.pages ?? 1) !== 1
        ) {
            throw new Error('Only a single raster image is supported');
        }
        // Chuẩn hóa ảnh: xoay, làm phẳng nền, resize, chuyển sang không gian màu sRGB, loại bỏ alpha, xuất ra PNG.
        normalized = await image
            .rotate()
            .flatten({ background: '#ffffff' })
            .resize(SCORE_POLICY.maxSide, SCORE_POLICY.maxSide, {
                fit: 'inside',
                withoutEnlargement: true,
            })
            .toColourspace('srgb')
            .removeAlpha()
            .png()
            .toBuffer({ resolveWithObject: true });
    } catch (_error) {
        throw new JobError(
            'INVALID_MARKER_IMAGE',
            'Ảnh hỏng, quá lớn khi giải nén hoặc không phải ảnh tĩnh JPG/PNG/WebP.',
        );
    }
    signal.throwIfAborted();
    const { width, height } = normalized.info;
    if (width < 64 || height < 64)
        throw new JobError('IMAGE_TOO_SMALL', 'Ảnh marker cần ít nhất 64 px mỗi chiều.');
    // Chuyển ảnh sang grayscale.
    const gray = await sharp(normalized.data).greyscale().raw().toBuffer();

    // Khởi tạo ORB và các biến để lưu trữ kết quả.
    const { cv } = await getOpenCv();
    signal.throwIfAborted();

    const image = cv.matFromArray(height, width, cv.CV_8UC1, gray);
    const mask = new cv.Mat();
    const keys = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    const orb = new cv.ORB(SCORE_POLICY.maxFeatures);
    const points: Point[] = [];
    const selected: number[] = [];
    try {
        // Phát hiện các điểm đặc trưng và tính toán descriptors.
        orb.detectAndCompute(image, mask, keys, descriptors);
        const seen = new Set<string>();

        // Loại các điểm quá gần nhau
        for (let i = 0; i < keys.size(); i++) {
            const point = keys.get(i).pt as Point;
            const cell = `${Math.floor(point.x / 4)}:${Math.floor(point.y / 4)}`;
            if (seen.has(cell)) continue;
            seen.add(cell);
            points.push({ x: point.x, y: point.y });
            selected.push(i);
        }
        // Chuyển các descriptors đã chọn sang Uint8Array.
        const bytes = new Uint8Array(points.length * 32);
        if (points.length && descriptors.cols !== 32)
            throw new Error('Unexpected ORB descriptor width');
        selected.forEach((row, i) => {
            bytes.set(descriptors.data.subarray(row * 32, (row + 1) * 32), i * 32);
        });

        // Tính Features, Coverage và Score dựa trên số lượng điểm đặc trưng và độ phủ.
        const cells = gridCounts(points, width, height);
        const features = points.length;
        const coverage = cells.filter((count) => count > 0).length / 16;
        signal.throwIfAborted();
        return {
            width,
            height,
            png: normalized.data,
            digest: createHash('sha256').update(normalized.data).digest('hex'),
            points,
            descriptors: bytes,
            cells,
            features,
            coverage,
            score: starScore(features, coverage),
            hints: scoreHints(features, coverage),
        };
    } finally {
        orb.delete();
        descriptors.delete();
        keys.delete();
        mask.delete();
        image.delete();
    }
}

/**
 * Tính toán độ tương đồng giữa hai ảnh marker dựa trên các đặc trưng đã phân tích.
 * @param a Phân tích marker của ảnh đầu tiên
 * @param b Phân tích marker của ảnh thứ hai
 * @param signal Tín hiệu hủy bỏ để dừng tính toán nếu cần
 * @returns Độ tương đồng từ 0 đến 1, với 1 là giống hệt nhau.
 */
export async function markerSimilarity(
    a: MarkerAnalysis,
    b: MarkerAnalysis,
    signal: AbortSignal,
): Promise<number> {
    signal.throwIfAborted();
    if (a.digest === b.digest) return 1;
    if (Math.min(a.features, b.features) < SCORE_POLICY.minInliers) return 0;

    const { cv } = await getOpenCv();
    signal.throwIfAborted();
    const left = cv.matFromArray(a.features, 32, cv.CV_8UC1, a.descriptors);
    const right = cv.matFromArray(b.features, 32, cv.CV_8UC1, b.descriptors);
    // Sử dụng BFMatcher để tìm các cặp điểm đặc trưng giữa hai ảnh marker.
    const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    function candidates(from: cvTypes.Mat, to: cvTypes.Mat) {
        const matches = new cv.DMatchVectorVector();
        const accepted = new Map<number, number>();
        try {
            // Tìm các cặp điểm đặc trưng gần nhau nhất giữa hai ảnh marker sử dụng thuật toán KNN với k=2.
            matcher.knnMatch(from, to, matches, 2);
            for (let i = 0; i < matches.size(); i++) {
                const pair = matches.get(i);
                try {
                    if (pair.size() < 2) continue;
                    const first = pair.get(0) as Match;
                    const second = pair.get(1) as Match;

                    // Lọc các cặp điểm đặc trưng bằng Ratio Test
                    if (
                        first.distance <= 64 &&
                        first.distance < SCORE_POLICY.ratio * second.distance
                    ) {
                        accepted.set(first.queryIdx, first.trainIdx);
                    }
                } finally {
                    pair.delete();
                }
            }
            return accepted;
        } finally {
            matches.delete();
        }
    }
    try {
        // So khớp 2 chiều
        const forward = candidates(left, right);
        const reverse = candidates(right, left);
        const pairs = [...forward].filter(([i, j]) => reverse.get(j) === i);

        if (pairs.length < SCORE_POLICY.minInliers) return 0;
        const fromPoints = pairs.map(([i]) => a.points[i] as Point);
        const toPoints = pairs.map(([, j]) => b.points[j] as Point);
        const from = cv.matFromArray(
            pairs.length,
            1,
            cv.CV_32FC2,
            fromPoints.flatMap((p) => [p.x, p.y]),
        );
        const to = cv.matFromArray(
            pairs.length,
            1,
            cv.CV_32FC2,
            toPoints.flatMap((p) => [p.x, p.y]),
        );
        const inliers = new cv.Mat();
        let matrix: cvTypes.Mat | undefined;
        try {
            // Dùng RANSAC và Homography
            matrix = cv.findHomography(from, to, cv.RANSAC, 3, inliers, 2000, 0.995);
            if (matrix.empty()) return 0;
            const goodA = fromPoints.filter((_, i) => inliers.data[i] === 1);
            const goodB = toPoints.filter((_, i) => inliers.data[i] === 1);
            if (goodA.length < SCORE_POLICY.minInliers) return 0;
            if (
                gridCounts(goodA, a.width, a.height).filter(Boolean).length < 4 ||
                gridCounts(goodB, b.width, b.height).filter(Boolean).length < 4
            )
                return 0;
            signal.throwIfAborted();
            return Math.min(1, goodA.length / Math.min(a.features, b.features));
        } finally {
            matrix?.delete();
            inliers.delete();
            to.delete();
            from.delete();
        }
    } finally {
        matcher.delete();
        right.delete();
        left.delete();
    }
}

/**
 * Tạo ảnh heatmap dựa trên phân tích marker, hiển thị các ô có đặc trưng và các điểm đặc trưng.
 */
export async function renderHeatmap(
    analysis: MarkerAnalysis,
    signal: AbortSignal,
): Promise<Buffer> {
    signal.throwIfAborted();
    const { width, height, cells, points } = analysis;
    const rects = cells.map(
        (count, i) =>
            `<rect x="${((i % 4) * width) / 4}" y="${(Math.floor(i / 4) * height) / 4}" width="${width / 4}" height="${height / 4}" fill="${count ? '#22c55e' : '#ef4444'}" fill-opacity="0.14" stroke="#ffffff" stroke-width="1"/>`,
    );
    const dots = points.map(
        (p) =>
            `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="2" fill="#00ff66" stroke="#003311" stroke-width="0.5"/>`,
    );
    const overlay = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects.join('')}${dots.join('')}</svg>`,
    );
    const png = await sharp(analysis.png)
        .composite([{ input: overlay }])
        .png()
        .toBuffer();
    signal.throwIfAborted();
    return png;
}
