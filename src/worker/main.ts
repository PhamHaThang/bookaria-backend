import { logger } from '../config';
import { disconnectDatabase } from '../db';
import { startWorker, stopWorker } from '.';

async function shutdown(signal: string): Promise<void> {
    logger.info(`Nhận ${signal}, đang dừng worker...`);
    try {
        await stopWorker();
        await disconnectDatabase();
        process.exit(0);
    } catch (err) {
        logger.error({ err }, 'Lỗi khi dừng worker');
        process.exit(1);
    }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
    await startWorker();
} catch (err) {
    logger.error({ err }, 'Không thể khởi động worker');
    process.exit(1);
}
