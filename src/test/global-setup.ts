import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { env } from '../config';
import { createTestDatabaseTarget } from './database-target';

let activeTarget: ReturnType<typeof createTestDatabaseTarget> | undefined;

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

export async function setup() {
    const target = createTestDatabaseTarget(process.env.TEST_DATABASE_URL ?? env.DATABASE_URL);
    try {
        await withAdmin(target.adminUrl, async (client) => {
            await client.query(`CREATE DATABASE ${quote(target.name)}`);
            activeTarget = target;
        });
        await runner({
            databaseUrl: target.url,
            dir: 'migrations',
            direction: 'up',
            migrationsTable: 'pgmigrations',
            log: () => {},
        });
    } catch (err) {
        if (process.env.CI) throw err;
        process.env.SKIP_DB_TESTS = '1';
        console.warn(
            `\n[test] Không kết nối được Postgres (${(err as Error).message}). Bỏ qua các test cần DB.\n` +
                '       Chạy `pnpm docker:up` rồi chạy lại để có đủ test.\n',
        );
        return;
    }
    process.env.DATABASE_URL = target.url;
}

export async function teardown() {
    const target = activeTarget;
    if (!target) return;
    await withAdmin(target.adminUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${quote(target.name)} WITH (FORCE)`),
    ).catch(() => {});
    activeTarget = undefined;
}
