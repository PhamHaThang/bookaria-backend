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
            const lastPreMergeMigration = '1792368000000_version-print-source.sql';
            const markerMigration = '1792454400000_active-bookaria-markers.sql';
            expect(migrationFiles).toContain(lastPreMergeMigration);
            expect(migrationFiles).toContain(markerMigration);
            for (const file of migrationFiles) {
                if (file <= lastPreMergeMigration) {
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

            await expect(
                runner({
                    databaseUrl: upgradeUrl,
                    dir: migrationDir,
                    direction: 'up',
                    migrationsTable: 'pgmigrations',
                    log: () => {},
                }),
            ).resolves.toBeDefined();

            const upgraded = new pg.Client({ connectionString: upgradeUrl });
            try {
                await upgraded.connect();
                const { rows } = await upgraded.query<{ name: string }>(
                    `SELECT name FROM pgmigrations WHERE name = $1`,
                    [markerMigration.slice(0, -4)],
                );
                expect(rows).toHaveLength(1);
                const trigger = await upgraded.query<{ exists: boolean }>(
                    `SELECT EXISTS (
                        SELECT 1 FROM pg_trigger
                        WHERE tgrelid = 'public.pages'::regclass
                          AND tgname = 'pages_check_active_bookaria_marker_trg'
                          AND NOT tgisinternal
                    ) AS exists`,
                );
                expect(trigger.rows[0]?.exists).toBe(true);
            } finally {
                await upgraded.end();
            }
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
