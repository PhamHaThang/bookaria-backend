import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { MarkerAnalysis } from '../worker/score/types';
import {
    analyzeMarker,
    markerSimilarity,
    renderHeatmap,
    SCORE_POLICY,
} from '../worker/score/vision';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
type Analysis = { file: string; result: MarkerAnalysis };
type ImageResult = {
    file: string;
    digest?: string;
    width?: number;
    height?: number;
    features?: number;
    coverage?: number;
    score?: number;
    hints?: string[];
    overlay?: string;
    durationMs?: number;
    error?: string;
};
type Comparison = {
    a: string;
    b: string;
    similarity?: number;
    warning?: boolean;
    error?: string;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function csvCell(value: string | number | undefined): string {
    const raw = String(value ?? '');
    const safe = /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
}

function csv(rows: (string | number | undefined)[][]): string {
    return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

async function main(): Promise<void> {
    const [inputArg, outputArg, ...extra] = process.argv.slice(2);
    if (!inputArg || !outputArg || extra.length) {
        throw new Error(
            'Dùng: pnpm exec tsx src/scripts/score-markers-local.ts <thư-mục-ảnh> <thư-mục-kết-quả-mới>',
        );
    }
    const input = resolve(inputArg);
    const output = resolve(outputArg);
    if (input === output) throw new Error('Thư mục kết quả phải khác thư mục ảnh.');
    if (!(await stat(input)).isDirectory()) throw new Error('Đường dẫn ảnh phải là thư mục.');

    const files = (await readdir(input, { withFileTypes: true }))
        .filter(
            (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()),
        )
        .map((entry) => entry.name)
        .sort();
    if (files.length < 1 || files.length > 50)
        throw new Error('Chọn thư mục có 1–50 ảnh JPG/PNG/WebP ngay trong thư mục đó.');

    // mkdir không có recursive: thư mục kết quả phải mới, thư mục cha phải có sẵn.
    await mkdir(output);
    const signal = new AbortController().signal;
    const results: ImageResult[] = [];
    const analyses: Analysis[] = [];
    for (const [index, file] of files.entries()) {
        const started = performance.now();
        try {
            const path = join(input, file);
            const size = (await stat(path)).size;
            if (size === 0 || size > SCORE_POLICY.maxBytes)
                throw new Error('Ảnh rỗng hoặc vượt giới hạn 10 MiB.');
            const result = await analyzeMarker(await readFile(path), signal);
            const overlay = `${String(index + 1).padStart(2, '0')}-heatmap.png`;
            await writeFile(join(output, overlay), await renderHeatmap(result, signal));
            results.push({
                file,
                digest: result.digest,
                width: result.width,
                height: result.height,
                features: result.features,
                coverage: result.coverage,
                score: result.score,
                hints: result.hints,
                overlay,
                durationMs: Math.round(performance.now() - started),
            });
            analyses.push({ file, result });
        } catch (error) {
            results.push({ file, error: errorText(error) });
        }
    }

    const comparisons: Comparison[] = [];
    for (let i = 0; i < analyses.length; i++) {
        const a = analyses[i];
        if (!a) continue;
        for (let j = i + 1; j < analyses.length; j++) {
            const b = analyses[j];
            if (!b) continue;
            try {
                const similarity = await markerSimilarity(a.result, b.result, signal);
                comparisons.push({
                    a: a.file,
                    b: b.file,
                    similarity,
                    warning: similarity >= SCORE_POLICY.similarThreshold,
                });
            } catch (error) {
                comparisons.push({ a: a.file, b: b.file, error: errorText(error) });
            }
        }
    }

    await writeFile(
        join(output, 'report.json'),
        `${JSON.stringify({ policy: SCORE_POLICY, createdAt: new Date().toISOString(), results, comparisons }, null, 2)}\n`,
    );
    // Các cột đo trên thiết bị để trống; không suy ra khả năng nhận diện từ ORB.
    await writeFile(
        join(output, 'observations.csv'),
        csv([
            [
                'file',
                'features',
                'coverage',
                'score',
                'printWidthMm',
                'device',
                'lighting',
                'distanceCm',
                'angleDegrees',
                'attempts',
                'correctRecognitions',
                'medianRecognitionMs',
                'trackingLosses',
                'notes',
            ],
            ...results
                .filter((result) => result.score !== undefined)
                .map((result) => [result.file, result.features, result.coverage, result.score]),
        ]),
    );
    await writeFile(
        join(output, 'pair-observations.csv'),
        csv([
            ['imageA', 'imageB', 'similarity', 'warning', 'tested', 'confused', 'notes'],
            ...comparisons
                .filter((comparison) => comparison.similarity !== undefined)
                .map((comparison) => [
                    comparison.a,
                    comparison.b,
                    comparison.similarity,
                    comparison.warning ? 'yes' : 'no',
                ]),
        ]),
    );
    console.log(
        `Đã đo ${analyses.length}/${files.length} ảnh và ${comparisons.length} cặp tại ${output}`,
    );
    console.log('Điền kết quả thử MindAR vào hai file CSV trước khi hiệu chuẩn ngưỡng.');
    if (results.some((result) => result.error) || comparisons.some((pair) => pair.error)) {
        console.error('Một số ảnh hoặc cặp bị lỗi; xem report.json.');
        process.exitCode = 1;
    }
}

main().catch((error: unknown) => {
    console.error(errorText(error));
    process.exitCode = 1;
});
