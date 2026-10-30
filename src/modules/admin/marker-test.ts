import sharp, { type Metadata } from 'sharp';
import { type MarkerTestResult, MarkerTestResultSchema } from '../../schema';
import { AppError } from '../../utils';
import { analyzeMarker, SCORE_POLICY } from '../../worker/score/vision';
import { JobError } from '../jobs/jobs.types';

// Bound OpenCV memory and work; the admin can cancel and choose another image.
let analyzing = false;
export async function testMarkerImage(
    bytes: Buffer,
    signal: AbortSignal,
): Promise<MarkerTestResult> {
    if (analyzing)
        throw new AppError(
            'RATE_LIMITED',
            'Đang phân tích một ảnh marker khác. Hãy thử lại sau giây lát.',
        );
    if (!bytes.length) throw new AppError('VALIDATION_ERROR', 'Chọn ảnh marker có dữ liệu.');
    if (bytes.length > SCORE_POLICY.maxBytes) throw new AppError('FILE_TOO_LARGE');
    analyzing = true;
    try {
        let dimensions: Metadata;
        try {
            dimensions = await sharp(bytes, {
                limitInputPixels: SCORE_POLICY.maxPixels,
                failOn: 'warning',
            }).metadata();
        } catch {
            throw new AppError(
                'VALIDATION_ERROR',
                'Ảnh hỏng, quá lớn khi giải nén hoặc không phải ảnh tĩnh JPG/PNG/WebP.',
            );
        }
        const width = dimensions.width ?? 0,
            height = dimensions.height ?? 0;
        const scale = Math.min(1, SCORE_POLICY.maxSide / Math.max(1, width, height));
        if (Math.min(width, height) * scale < 128)
            throw new AppError(
                'VALIDATION_ERROR',
                'Ảnh quá nhỏ hoặc quá hẹp. Hãy dùng ảnh marker lớn hơn, hai chiều từ 128 px.',
            );
        const result = await analyzeMarker(bytes, signal);
        return MarkerTestResultSchema.parse({
            policyVersion: SCORE_POLICY.version,
            algorithm: 'ORB',
            score: result.score,
            features: result.features,
            coverage: result.coverage,
            width: result.width,
            height: result.height,
            image: `data:image/png;base64,${result.png.toString('base64')}`,
            points: result.points,
            cells: result.cells,
            hints: result.hints.filter(
                (hint) =>
                    !hint.includes('dùng marker Bookaria') && !hint.startsWith('Điểm tham khảo;'),
            ),
        });
    } catch (error) {
        if (
            error instanceof JobError &&
            ['INVALID_IMAGE_SIZE', 'INVALID_MARKER_IMAGE'].includes(error.code)
        ) {
            throw new AppError('VALIDATION_ERROR', error.message);
        }
        throw error;
    } finally {
        analyzing = false;
    }
}
