import { logger } from '../config';

export async function startWorker(): Promise<void> {
    logger.info('Khởi tạo worker...');
    // TODO: đăng ký các job nền tại đây
}

export async function stopWorker(): Promise<void> {
    logger.info('Đã dừng worker');
}
