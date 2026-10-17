import { PgBoss } from 'pg-boss';
import { env, logger } from '../config';
import { pool } from '../db';
import { jobsRepository } from '../modules/jobs/jobs.repository';
import { JobTypeSchema } from '../schema';
import { failAbandonedJob, MAX_ATTEMPTS, runJob } from './runner';
import type { Worker, WorkerOptions } from './types';

// Số lượng job được lấy từ cơ sở dữ liệu trong một lần dispatch.
const BATCH = 100;
// Thời gian chờ trước khi reaper đánh dấu job quá hạn là thất bại.
const REAPER_GRACE_SECONDS = 60;

/** Khởi tạo một worker để dispatch job từ cơ sở dữ liệu sang hàng đợi của pg-boss và chạy. */
export async function startQueueWorker(options: WorkerOptions): Promise<Worker> {
    // Lấy các giá trị mặc định nếu không được cung cấp trong options và kiểm tra tính hợp lệ của chúng.
    const dispatchEveryMs = options.dispatchEveryMs ?? 2_000;
    const pollingSeconds = options.pollingSeconds ?? 2;
    const concurrency = options.concurrency ?? 2;
    const retryDelaySeconds = options.retryDelaySeconds ?? 5;
    const expireSeconds = options.expireSeconds ?? 900;

    if (!Number.isSafeInteger(dispatchEveryMs) || dispatchEveryMs < 0) {
        throw new RangeError('dispatchEveryMs phải là số nguyên không âm');
    }
    if (!Number.isFinite(pollingSeconds) || pollingSeconds < 0.5) {
        throw new RangeError('pollingSeconds phải từ 0.5 trở lên');
    }
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new RangeError('concurrency phải là số nguyên dương');
    }
    if (!Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 1) {
        throw new RangeError('retryDelaySeconds phải là số nguyên dương');
    }
    if (!Number.isSafeInteger(expireSeconds) || expireSeconds < 1) {
        throw new RangeError('expireSeconds phải là số nguyên dương');
    }

    // Khởi tạo pg-boss với các tùy chọn cấu hình.
    const boss = new PgBoss({
        connectionString: env.DATABASE_URL,
        schema: options.schema ?? 'pgboss',
        ssl: env.DATABASE_SSL,
        max: 10,
        schedule: false,
    });

    boss.on('error', (err) => {
        logger.error({ err }, 'Lỗi trong PgBoss');
    });

    // Lọc ra các loại job có handler tương ứng.
    const types = JobTypeSchema.options.filter((type) => options.handlers[type] !== undefined);

    // Vị trí đã quét rong danh sách Job
    let cursor:
        | {
              id: string;
              createdAt: Date;
          }
        | undefined;

    let timer: NodeJS.Timeout | undefined;

    // Promise của lần dispatch đang chạy, nếu có.
    let inFlight: Promise<number> | undefined;

    // Promise của lần dừng worker đang chạy, nếu có.
    let stopPromise: Promise<void> | undefined;

    // Cờ để đánh dấu worker đang dừng.
    let stopping = false;

    // Dispatch job từ cơ sở dữ liệu sang hàng đợi của pg-boss.
    async function dispatch(): Promise<number> {
        // Tìm và xử lý các Abandoned Job trước khi dispatch các job mới.
        const timeoutSeconds = expireSeconds + REAPER_GRACE_SECONDS;

        const abandonedJobs = await jobsRepository.getAbandonedJobs(
            pool,
            MAX_ATTEMPTS,
            timeoutSeconds,
            BATCH,
        );
        for (const { id } of abandonedJobs) {
            await failAbandonedJob(id, timeoutSeconds);
        }

        // Lấy danh sách các job đang chờ xử lý từ cơ sở dữ liệu
        const queued = await jobsRepository.getQueuedJobs(pool, types, BATCH, cursor);
        let sentCount = 0;

        // Gửi từng job sang hàng đợi của pg-boss.
        for (const { id, type } of queued) {
            const queueId = await boss.send(
                type,
                {
                    jobId: id,
                },
                { id },
            );
            if (queueId) sentCount++;
        }

        // Cập nhật cursor để tiếp tục từ vị trí cuối cùng trong lần dispatch này.
        const last = queued.at(-1);
        cursor =
            last && queued.length === BATCH
                ? { id: last.id, createdAt: last.created_at }
                : undefined;
        return sentCount;
    }

    // Tick function để thực hiện dispatch job định kỳ.
    function tick(): Promise<number> {
        if (stopping) return Promise.resolve(0);
        if (!inFlight) {
            inFlight = dispatch().finally(() => {
                inFlight = undefined;
            });
        }
        return inFlight;
    }

    // Chờ dispatch đang chạy rồi dừng pg-boss.
    function stop(): Promise<void> {
        if (stopPromise) return stopPromise;
        stopping = true;
        if (timer) clearInterval(timer);
        stopPromise = (async () => {
            if (inFlight) {
                try {
                    await inFlight;
                } catch (error) {
                    logger.error({ err: error }, 'Lỗi khi dừng worker');
                }
            }
            await boss.stop({ graceful: true, timeout: 8_000 });
        })();
        return stopPromise;
    }

    try {
        await boss.start();

        for (const type of types) {
            const handler = options.handlers[type];
            if (!handler) continue;

            const queueConfig = {
                retryLimit: MAX_ATTEMPTS - 1,
                retryBackoff: true,
                retryDelay: retryDelaySeconds,
                expireInSeconds: expireSeconds,
            } satisfies NonNullable<Parameters<PgBoss['createQueue']>[1]>;
            await boss.createQueue(type, queueConfig);
            await boss.updateQueue(type, queueConfig);

            await boss.work<{ jobId: string }>(
                type,
                {
                    batchSize: 1,
                    localConcurrency: concurrency,
                    pollingIntervalSeconds: pollingSeconds,
                },
                async ([queued]) => {
                    if (!queued) return;
                    await runJob(queued.data.jobId, handler, queued.signal);
                },
            );
        }

        await tick();
        if (dispatchEveryMs > 0) {
            timer = setInterval(() => {
                void tick().catch((error) => {
                    logger.error({ err: error }, 'Lỗi khi dispatch job');
                });
            }, dispatchEveryMs);
        }
        return {
            boss,
            tick,
            stop,
        };
    } catch (error) {
        stopping = true;
        if (timer) clearInterval(timer);
        try {
            await boss.stop({ graceful: false });
        } catch (cleanupError) {
            logger.error({ err: cleanupError }, 'Không thể dọn pg-boss sau lỗi khởi động');
        }
        throw error;
    }
}
