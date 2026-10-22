import { randomUUID } from 'node:crypto';

export function createTestDatabaseTarget(connectionString: string) {
    const url = new URL(connectionString);
    const base = decodeURIComponent(url.pathname.slice(1));
    // Keep the generated identifier ASCII and below PostgreSQL's 63-byte limit.
    const prefix = base.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32) || 'bookaria';
    const name = `${prefix}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
    url.pathname = `/${name}`;
    const admin = new URL(url);
    admin.pathname = '/postgres';
    return { url: url.toString(), name, adminUrl: admin.toString() };
}
