import { logger } from '../config';
import { handlers } from './handlers';
import { startQueueWorker } from './queue';
import type { Worker } from './types';

let instance: Worker | undefined;
let starting: Promise<Worker> | undefined;
let stopping: Promise<void> | undefined;

/** Khởi động một worker cho tiến trình hiện tại. */
export async function startWorker(): Promise<void> {
    if (stopping) await stopping;
    if (instance) return;
    starting ??= startQueueWorker({ handlers })
        .then((worker) => {
            instance = worker;
            logger.info('Worker đã sẵn sàng');
            return worker;
        })
        .finally(() => {
            starting = undefined;
        });
    await starting;
}

/** Dừng worker hiện tại. */
export async function stopWorker(): Promise<void> {
    if (stopping) return stopping;

    stopping = (async () => {
        const worker = instance ?? (await starting);
        if (!worker) return;
        instance = undefined;
        await worker.stop();
        logger.info('Worker đã dừng');
    })().finally(() => {
        stopping = undefined;
    });
    return stopping;
}
