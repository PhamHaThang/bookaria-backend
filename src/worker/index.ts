import { logger } from '../config';

export async function startWorker(): Promise<void> {
    logger.info('Khởi tạo worker...');
    // TODO: kết nối Redis và đăng ký các BullMQ Worker tại đây
}

export async function stopWorker(): Promise<void> {
    logger.info('Đã dừng worker');
}
