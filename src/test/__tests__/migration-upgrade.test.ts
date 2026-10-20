import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const databaseName = (connectionString: string) => {
    const url = new URL(connectionString);
    return decodeURIComponent(url.pathname.slice(1));
};

const connectionStringForDatabase = (connectionString: string, name: string) => {
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    return url.toString();
};

describe.skipIf(Boolean(process.env.SKIP_DB_TESTS))('migration upgrades', () => {
    it('applies the latest migration after a database has the pre-merge schema', async () => {
        const configuredUrl = process.env.DATABASE_URL;
        if (!configuredUrl) throw new Error('DATABASE_URL is required for migration tests');

        const baseName = databaseName(configuredUrl);
        const upgradeName = `${baseName.slice(0, 42)}_upgrade_${process.pid}`;
        const upgradeUrl = connectionStringForDatabase(configuredUrl, upgradeName);
        const adminUrl = connectionStringForDatabase(configuredUrl, 'postgres');
        const migrationDir = resolve(process.cwd(), 'migrations');
        const temporaryDir = await mkdtemp(join(tmpdir(), 'bookaria-migrations-'));
        const admin = new pg.Client({ connectionString: adminUrl });
        let adminConnected = false;

        try {
            await admin.connect();
            adminConnected = true;
            await admin.query(
                `DROP DATABASE IF EXISTS ${quoteIdentifier(upgradeName)} WITH (FORCE)`,
            );
            await admin.query(`CREATE DATABASE ${quoteIdentifier(upgradeName)}`);
            await admin.end();
            adminConnected = false;

            const migrationFiles = (await readdir(migrationDir)).filter((file) =>
                file.endsWith('.sql'),
            );
            const latestMigration = '1792454400000_active-bookaria-markers.sql';
            for (const file of migrationFiles) {
                if (file !== latestMigration) {
                    await copyFile(join(migrationDir, file), join(temporaryDir, file));
                }
            }

            await runner({
                databaseUrl: upgradeUrl,
                dir: temporaryDir,
                direction: 'up',
                migrationsTable: 'pgmigrations',
                log: () => {},
            });

            await copyFile(
                join(migrationDir, latestMigration),
                join(temporaryDir, latestMigration),
            );
            await expect(
                runner({
                    databaseUrl: upgradeUrl,
                    dir: temporaryDir,
                    direction: 'up',
                    migrationsTable: 'pgmigrations',
                    log: () => {},
                }),
            ).resolves.toBeDefined();
        } finally {
            if (adminConnected) await admin.end();
            const cleanup = new pg.Client({ connectionString: adminUrl });
            await cleanup.connect();
            await cleanup.query(
                `DROP DATABASE IF EXISTS ${quoteIdentifier(upgradeName)} WITH (FORCE)`,
            );
            await cleanup.end();
            await rm(temporaryDir, { recursive: true, force: true });
        }
    });
});
