import type { Server } from 'node:http';
import { createApp } from './app';
import { env, logger } from './config';
import { connectDatabase, disconnectDatabase } from './db';
import { warmUpPasswordCheck } from './lib';
import { startWorker, stopWorker } from './worker';

let server: Server | undefined;

async function shutdown(signal: string): Promise<void> {
    logger.info(`Nhận ${signal}, đang tắt server...`);
    const force = setTimeout(() => {
        logger.error('Tắt server quá thời gian, buộc thoát');
        process.exit(1);
    }, 10_000);
    force.unref();

    try {
        if (server) {
            const s = server;
            await new Promise<void>((resolve, reject) =>
                s.close((err) => (err ? reject(err) : resolve())),
            );
            s.closeIdleConnections();
        }
        if (env.RUN_WORKER_IN_PROCESS) await stopWorker();
        await disconnectDatabase();
        process.exit(0);
    } catch (err) {
        logger.error({ err }, 'Lỗi khi tắt server');
        process.exit(1);
    }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
    await connectDatabase();
    await warmUpPasswordCheck();

    if (env.RUN_WORKER_IN_PROCESS) {
        await startWorker();
    }

    const app = createApp();
    await new Promise<void>((resolve, reject) => {
        server = app.listen(env.PORT, () => {
            logger.info(`Server chạy ở http://localhost:${env.PORT}/api/v1`);
            resolve();
        });
        server.once('error', reject);
    });
}

try {
    await main();
} catch (err) {
    logger.error({ err }, 'Không thể khởi động server');
    process.exit(1);
}
