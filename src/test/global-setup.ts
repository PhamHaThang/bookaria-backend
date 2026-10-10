import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { env } from '../config';

function resolveTarget() {
    const configured = process.env.TEST_DATABASE_URL;
    const url = new URL(configured ?? env.DATABASE_URL);
    if (!configured) url.pathname = `${url.pathname}_test`;
    const name = decodeURIComponent(url.pathname.slice(1));
    const admin = new URL(url);
    admin.pathname = '/postgres';
    return { url: url.toString(), name, adminUrl: admin.toString() };
}

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
    const target = resolveTarget();
    try {
        await withAdmin(target.adminUrl, async (client) => {
            await client.query(`DROP DATABASE IF EXISTS ${quote(target.name)} WITH (FORCE)`);
            await client.query(`CREATE DATABASE ${quote(target.name)}`);
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
    if (process.env.SKIP_DB_TESTS) return;
    const target = resolveTarget();
    await withAdmin(target.adminUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${quote(target.name)} WITH (FORCE)`),
    ).catch(() => {});
}
