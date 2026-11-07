import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { analyzeCompiledMarker } from '../worker/score/pictarize';

/** Inspect browser-compiled targets with the same policy as SCORE_MARKER. No server compilation. */
async function main() {
    const [imageArg, mindArg, outputArg, ...extra] = process.argv.slice(2);
    if (!imageArg || !mindArg || !outputArg || extra.length)
        throw new Error(
            'Dùng: pnpm exec tsx src/scripts/analyze-markers-local.ts <ảnh> <mind> <thư-mục-kết-quả-mới>',
        );
    const images = resolve(imageArg),
        minds = resolve(mindArg),
        output = resolve(outputArg);
    if ([images, minds].includes(output)) throw new Error('Chọn thư mục kết quả riêng.');
    const files = (await readdir(images, { withFileTypes: true }))
        .filter(
            (entry) =>
                entry.isFile() &&
                ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(entry.name).toLowerCase()),
        )
        .map((entry) => entry.name)
        .sort();
    if (!files.length || files.length > 50) throw new Error('Chọn thư mục có 1–50 ảnh.');
    await mkdir(output);
    const signal = new AbortController().signal;
    const results = [];
    for (const file of files) {
        const metadata = await sharp(await readFile(join(images, file)), {
            limitInputPixels: 16_777_216,
        }).metadata();
        const size = metadata.autoOrient;
        const result = analyzeCompiledMarker(
            await readFile(join(minds, `${basename(file, extname(file))}.mind`)),
            size.width,
            size.height,
            signal,
        );
        results.push({ file, ...result });
        console.log(JSON.stringify({ file, features: result.features, ...result.analysis }));
    }
    await writeFile(
        join(output, 'report.json'),
        `${JSON.stringify({ createdAt: new Date().toISOString(), images, minds, results }, null, 2)}\n`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
