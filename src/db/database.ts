import pg, { type QueryResultRow } from 'pg';
import { env, logger } from '../config';

export const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

/** Anything that can run a query: the pool, or one client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

// Lỗi từ idle client: chỉ log, pool sẽ tự loại client hỏng và tạo kết nối mới.
pool.on('error', (err) => {
    logger.error({ err }, 'Lỗi kết nối cơ sở dữ liệu (idle client)');
});

// ── Connection helper───────────────────────────────
export async function connectDatabase(): Promise<void> {
    const client = await pool.connect();
    client.release();
    logger.info('Đã kết nối cơ sở dữ liệu thành công');
}
// ── Graceful disconnect ───────────────────────────────────────────────────
export async function disconnectDatabase(): Promise<void> {
    await pool.end();
    logger.info('Ngắt kết nối cơ sở dữ liệu thành công');
}
// ── Query helper  ─────────────────────────
// Usage:
//   const users = await query<User>("SELECT * FROM users WHERE id = $1", [id]);
export async function query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
): Promise<T[]> {
    const result = await pool.query<T>(sql, params);
    return result.rows;
}

// ── Query helper — trả về 1 row (hoặc null) ──────────────────────────────
export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
): Promise<T | null> {
    const result = await pool.query<T>(sql, params);
    return result.rows[0] ?? null;
}

// Transaction helper
export async function withTransaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
