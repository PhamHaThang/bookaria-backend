import type { PgBoss } from 'pg-boss';
import type { JobHandlers } from '../modules/jobs/jobs.types';

/** Các tùy chọn để khởi tạo một worker. */
export interface WorkerOptions {
    // Các handler cho các loại job mà worker sẽ xử lý.
    handlers: JobHandlers;

    // Schema riêng của pg-boss.
    schema?: string;

    // Khoảng thời gian giữa hai lần dispatch job.
    dispatchEveryMs?: number;

    // Tần suất pg-boss lấy việc từ hàng đợi.
    pollingSeconds?: number;

    // Số worker cho mỗi loại Queue trong process.
    concurrency?: number;

    // Thời gian delay khi thử lại.
    retryDelaySeconds?: number;

    // Giới hạn thời gian cho một lần thực thi job.
    expireSeconds?: number;
}

export interface Worker {
    tick(): Promise<number>;
    stop(): Promise<void>;
    boss: PgBoss;
}
