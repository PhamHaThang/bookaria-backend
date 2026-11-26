import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pool } from '../db';
import { loadMarkerSeedSet, seedBookariaMarkers } from '../db/seed-markers';
import { getMediaStorage } from '../lib/storage';

try {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            'dry-run': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
    });
    const args = positionals.filter((value) => value !== '--');
    if (values.help) {
        console.info('pnpm db:seed:markers ["<thư mục khác chứa manifest.json>"] [--dry-run]');
        console.info(
            'Mặc định dùng assets/bookaria-markers. Có thể đổi bằng BOOKARIA_MARKER_DIR hoặc tham số thư mục.',
        );
        console.info(
            'Chạy lại sẽ dùng lại tệp và marker đã có, bổ sung kết quả cho marker chưa đánh giá.',
        );
    } else {
        if (args.length > 1)
            throw new Error('Chỉ truyền một thư mục bộ marker. Dùng --help để xem cách chạy.');
        const directory =
            args[0] ||
            process.env.BOOKARIA_MARKER_DIR ||
            fileURLToPath(new URL('../../assets/bookaria-markers/', import.meta.url));
        const markers = await loadMarkerSeedSet(directory);
        console.info(`Đã kiểm tra ${markers.length} cặp ảnh/nhận diện và SHA-256.`);
        console.info(
            `Có ${markers.filter((marker) => marker.assessment).length}/${markers.length} marker kèm kết quả đánh giá.`,
        );
        if (values['dry-run']) {
            console.info('Chạy thử hoàn tất. Không kết nối R2, không ghi database.');
        } else {
            const media = getMediaStorage();
            if (!media) throw new Error('Cần cấu hình R2_ENDPOINT trong .env.');
            const result = await seedBookariaMarkers(pool, media, markers, (message) =>
                console.info(message),
            );
            console.info(
                `Hoàn tất: ${result.created} marker mới, ${result.existing} marker đã có; ${result.uploaded} tệp tải lên, ${result.reused} tệp đã có.`,
            );
        }
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Seed marker thất bại.');
    process.exitCode = 1;
} finally {
    await pool.end();
}
