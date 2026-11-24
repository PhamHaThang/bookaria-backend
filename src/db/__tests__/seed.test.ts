import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '../database';

async function loadSeed(password: string) {
    vi.resetModules();
    vi.stubEnv('SEED_ADMIN_PASSWORD', password);
    return import('../seed');
}

function mockDatabase(adminExists: boolean) {
    const query = vi.fn<(sql: string, params: unknown[]) => Promise<{ rowCount: number }>>();
    query.mockResolvedValueOnce({ rowCount: adminExists ? 1 : 0 });
    query.mockResolvedValueOnce({ rowCount: 1 });
    return { query, db: { query } as unknown as Queryable };
}

afterEach(() => vi.unstubAllEnvs());

describe('admin seed password', () => {
    it('hashes the environment password before creating an admin', async () => {
        const password = randomBytes(24).toString('hex');
        const { seedDatabase } = await loadSeed(password);
        const { verifyPassword } = await import('../../lib/password');
        const { db, query } = mockDatabase(false);

        await seedDatabase(db);

        expect(query).toHaveBeenCalledTimes(2);
        const call = query.mock.calls[1];
        if (!call) throw new Error('Admin insert was not called');
        const [sql, params] = call;
        expect(sql).toContain('INSERT INTO users');
        expect(await verifyPassword(password, params[1] as string)).toBe(true);
    });

    it('fails before inserting an admin if the password is blank', async () => {
        const { seedDatabase } = await loadSeed('');
        const { db, query } = mockDatabase(false);

        await expect(seedDatabase(db)).rejects.toThrow('Thiếu SEED_ADMIN_PASSWORD');
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('leaves an existing admin untouched if the password is blank', async () => {
        const { seedDatabase } = await loadSeed('');
        const { db, query } = mockDatabase(true);

        await expect(seedDatabase(db)).resolves.toBeUndefined();
        expect(query).toHaveBeenCalledTimes(1);
    });
});
