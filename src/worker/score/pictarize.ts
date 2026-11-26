import { JobError } from '../../modules/jobs/jobs.types';
import { analyzeMindarLevel } from '../../schema/marker-analysis.schema';
import { decodeSingleMind } from '../publish/mind';

/** Read features already compiled in the browser. Never compile MindAR on the server. */
export function analyzeCompiledMarker(
    bytes: Uint8Array,
    width: number,
    height: number,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    const target = decodeSingleMind(bytes);
    try {
        return analyzeMindarLevel(target.matchingData[0], width, height, signal);
    } catch {
        signal.throwIfAborted();
        throw new JobError(
            'INVALID_MIND',
            'Dữ liệu phân tích ảnh không hợp lệ. Hãy chọn lại ảnh marker rồi thử lại.',
        );
    }
}
