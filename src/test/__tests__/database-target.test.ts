import { describe, expect, it } from 'vitest';
import { createTestDatabaseTarget } from '../database-target';

describe('test database targets', () => {
    it('isolates runs using the same connection configuration, even in the same process', () => {
        const base = 'postgresql://tester:local-only@localhost:5432/bookaria_test';
        const first = createTestDatabaseTarget(base);
        const second = createTestDatabaseTarget(base);
        expect(first.name).not.toBe(second.name);
        expect(first.name.endsWith('_test')).toBe(true);
        expect(second.name.endsWith('_test')).toBe(true);
        expect(first.name).not.toBe('bookaria_test');
        expect(second.name).not.toBe('bookaria_test');
        expect(new URL(first.url).pathname).toBe(`/${first.name}`);
    });

    it('keeps connection options while using a separate database and postgres for administration', () => {
        const base = new URL(
            'postgresql://tester:local-only@db.example:55434/bookaria?sslmode=require',
        );
        const target = createTestDatabaseTarget(base.toString());
        for (const value of [target.url, target.adminUrl]) {
            const url = new URL(value);
            expect(url.host).toBe(base.host);
            expect(url.username).toBe(base.username);
            expect(url.password).toBe(base.password);
            expect(url.search).toBe(base.search);
        }
        expect(new URL(target.adminUrl).pathname).toBe('/postgres');
        expect(new URL(target.url).pathname).not.toBe('/bookaria');
    });

    it.each(['dự_án_'.repeat(30), ''])(
        'creates a safe database name for a long or empty base',
        (base) => {
            const url = new URL('postgresql://tester:local-only@localhost/');
            url.pathname = `/${base}`;
            const { name } = createTestDatabaseTarget(url.toString());
            expect(name).toMatch(/^[a-zA-Z0-9_]+$/);
            expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
        },
    );
});
