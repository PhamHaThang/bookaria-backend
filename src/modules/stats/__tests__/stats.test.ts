import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { BookStatsSchema } from '../../../schema';
import { getSinceDate, statsService } from '../stats.service';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const bookStats = statsService.getTotalStats;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const NOW = new Date('2026-10-14T12:00:00.000Z');

interface Person {
    id: string;
    token: string;
}

const signUp = async (): Promise<Person> => {
    const email = `stats-${randomUUID()}@example.com`;
    const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ displayName: 'Tác giả', email, password: 'Matkhau-123' });
    return { id: res.body.data.user.id, token: res.body.data.accessToken };
};
const as = (p: Person) => ({ Authorization: `Bearer ${p.token}` });

const newBook = async (p: Person, title = 'Khủng long') => {
    const res = await request(app).post('/api/v1/books').set(as(p)).send({ title });
    return res.body.data.book.id as string;
};

const addPage = async (p: Person, bookId: string, title: string | null = null) => {
    const image = await pool.query<{ id: string }>(
        `INSERT INTO assets (owner_id, type, name, original_public_id, resource_type, format, size_bytes, status, meta)
     VALUES ($1, 'IMAGE', 'Ảnh trang', $2, 'image', 'png', 1000, 'READY', '{"width":640,"height":480}')
     RETURNING id`,
        [p.id, `stats/${randomUUID()}`],
    );
    const page = await pool.query<{ id: string }>(
        `INSERT INTO pages (book_id, order_index, title, image_asset_id, marker_mode, marker_mind_public_id, marker_score)
     SELECT $1, COALESCE(MAX(order_index) + 1, 0), $2, $3, 'CUSTOM_MARKER', 'stats/marker.mind', 3
     FROM pages WHERE book_id = $1 RETURNING id`,
        [bookId, title, image.rows[0]?.id],
    );
    return (page.rows[0] as { id: string }).id;
};

interface Ev {
    event: 'OPEN' | 'PAGE_FOUND' | 'TAP' | 'SCAN_TIMEOUT';
    at?: string;
    session?: string;
    page?: string | null;
    device?: [string, string] | null;
}

const addEvents = async (bookId: string, events: Ev[]) => {
    for (const e of events) {
        const [type, os] =
            e.device === undefined ? ['mobile', 'Android'] : (e.device ?? [null, null]);
        await pool.query(
            `INSERT INTO view_events (book_id, page_id, event, object_id, session_id, device_type, os,
                                created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                bookId,
                e.page ?? null,
                e.event,
                e.event === 'TAP' ? 'obj_1' : null,
                e.session ?? randomUUID(),
                type,
                os,
                e.at ?? NOW.toISOString(),
            ],
        );
    }
};

const get = (p: Person, bookId: string, query = '') =>
    request(app).get(`/api/v1/books/${bookId}/stats${query}`).set(as(p));

// ---------------------------------------------------------------------------------------------
describe('getSinceDate', () => {
    it('starts at midnight UTC of the first day, counting today as one', () => {
        expect(new Date(getSinceDate('7d', NOW)).toISOString()).toBe('2026-10-08T00:00:00.000Z');
        expect(new Date(getSinceDate('30d', NOW)).toISOString()).toBe('2026-09-15T00:00:00.000Z');
        expect(new Date(getSinceDate('90d', NOW)).toISOString()).toBe('2026-07-17T00:00:00.000Z');
    });

    it('does not move during the day', () => {
        const early = new Date('2026-10-14T00:00:00.000Z');
        const late = new Date('2026-10-14T23:59:59.999Z');
        expect(getSinceDate('7d', early)).toBe(getSinceDate('7d', late));
    });
});

// ---------------------------------------------------------------------------------------------
suite('GET /books/:bookId/stats', () => {
    it('answers with zeros for a book nobody has read, one row per day of the range', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const res = await get(a, bookId, '?range=7d');
        expect(res.status).toBe(200);
        const stats = BookStatsSchema.parse(res.body.data);
        expect(stats.range).toBe('7d');
        expect(stats.totals).toEqual({ opens: 0, sessions: 0, taps: 0, scanTimeouts: 0 });
        expect(stats.opensByDay).toHaveLength(7);
        expect(stats.opensByDay.every((d) => d.opens === 0)).toBe(true);
        expect(stats.byPage).toEqual([]);
        expect(stats.byDevice).toEqual([]);
    });

    it('defaults to 30 days and offers 7, 30 and 90', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        expect((await get(a, bookId)).body.data.range).toBe('30d');
        for (const [range, days] of [
            ['7d', 7],
            ['30d', 30],
            ['90d', 90],
        ] as const) {
            const res = await get(a, bookId, `?range=${range}`);
            expect(res.body.data.opensByDay).toHaveLength(days);
        }
    });

    it('lists consecutive days, oldest first, ending today (UTC)', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const { opensByDay } = await bookStats(a.id, bookId, { range: '7d' }, NOW);
        expect(opensByDay.map((d) => d.date)).toEqual([
            '2026-10-08',
            '2026-10-09',
            '2026-10-10',
            '2026-10-11',
            '2026-10-12',
            '2026-10-13',
            '2026-10-14',
        ]);
        const live = (await get(a, bookId, '?range=7d')).body.data.opensByDay;
        expect(live.at(-1).date).toBe(new Date().toISOString().slice(0, 10));
    });

    it('counts opens, readers (distinct sessions), taps and scan time-outs', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const page = await addPage(a, bookId);
        const s1 = randomUUID();
        const s2 = randomUUID();
        await addEvents(bookId, [
            { event: 'OPEN', session: s1 },
            { event: 'PAGE_FOUND', session: s1, page },
            { event: 'TAP', session: s1, page },
            { event: 'TAP', session: s1, page },
            { event: 'OPEN', session: s2 },
            { event: 'SCAN_TIMEOUT', session: s2 },
            { event: 'OPEN', session: s2 },
        ]);
        const stats = await bookStats(a.id, bookId, { range: '7d' }, NOW);
        // Three opens by two readers: `sessions` counts readers, not opens.
        expect(stats.totals).toEqual({ opens: 3, sessions: 2, taps: 2, scanTimeouts: 1 });
    });

    it('puts each open on the day it happened, and keeps the days summed equal to the total', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        await addEvents(bookId, [
            { event: 'OPEN', at: '2026-10-14T11:00:00Z' },
            { event: 'OPEN', at: '2026-10-14T00:00:00Z' },
            { event: 'OPEN', at: '2026-10-13T23:59:59Z' },
            { event: 'OPEN', at: '2026-10-10T08:00:00Z' },
            { event: 'TAP', at: '2026-10-10T08:00:00Z' },
        ]);
        const stats = await bookStats(a.id, bookId, { range: '7d' }, NOW);
        const byDate = Object.fromEntries(stats.opensByDay.map((d) => [d.date, d.opens]));
        expect(byDate['2026-10-14']).toBe(2);
        expect(byDate['2026-10-13']).toBe(1);
        expect(byDate['2026-10-10']).toBe(1);
        expect(byDate['2026-10-12']).toBe(0);
        expect(stats.opensByDay.reduce((n, d) => n + d.opens, 0)).toBe(stats.totals.opens);
    });

    it('includes the first moment of the first day and leaves out the moment before it', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        await addEvents(bookId, [
            { event: 'OPEN', at: '2026-10-08T00:00:00.000Z' },
            { event: 'OPEN', at: '2026-10-07T23:59:59.999Z' },
        ]);
        const stats = await bookStats(a.id, bookId, { range: '7d' }, NOW);
        expect(stats.totals.opens).toBe(1);
        expect(stats.opensByDay[0]).toEqual({ date: '2026-10-08', opens: 1 });
        // The same events show up in a longer range.
        expect((await bookStats(a.id, bookId, { range: '30d' }, NOW)).totals.opens).toBe(2);
    });

    it('excludes events after today from both the total and daily chart', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        await addEvents(bookId, [
            { event: 'OPEN', at: '2026-10-14T23:59:59.999Z' },
            { event: 'OPEN', at: '2026-10-15T00:00:00.000Z' },
        ]);
        const stats = await bookStats(a.id, bookId, { range: '7d' }, NOW);
        expect(stats.totals.opens).toBe(1);
        expect(stats.opensByDay.at(-1)).toEqual({ date: '2026-10-14', opens: 1 });
    });

    it('applies the range to every counter, not only to the opens', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const page = await addPage(a, bookId);
        const old = '2026-09-01T10:00:00Z';
        await addEvents(bookId, [
            { event: 'OPEN', at: old },
            { event: 'PAGE_FOUND', at: old, page },
            { event: 'TAP', at: old, page },
            { event: 'SCAN_TIMEOUT', at: old },
        ]);
        const stats = await bookStats(a.id, bookId, { range: '7d' }, NOW);
        expect(stats.totals).toEqual({ opens: 0, sessions: 0, taps: 0, scanTimeouts: 0 });
        expect(stats.byPage[0]).toMatchObject({ found: 0, taps: 0 });
        expect(stats.byDevice).toEqual([]);
        expect((await bookStats(a.id, bookId, { range: '90d' }, NOW)).totals.opens).toBe(1);
    });

    it('gives every page of the book in order, numbered from 1, with its own counts', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const p1 = await addPage(a, bookId, 'Trang bìa');
        const p2 = await addPage(a, bookId);
        const p3 = await addPage(a, bookId, 'Cuối');
        await addEvents(bookId, [
            { event: 'PAGE_FOUND', page: p2 },
            { event: 'PAGE_FOUND', page: p2 },
            { event: 'TAP', page: p2 },
            { event: 'PAGE_FOUND', page: p3 },
            { event: 'TAP', page: p3 },
            { event: 'TAP', page: p3 },
            { event: 'TAP', page: p3 },
        ]);
        const { byPage } = await bookStats(a.id, bookId, { range: '30d' }, NOW);
        expect(byPage).toEqual([
            { pageId: p1, pageNumber: 1, title: 'Trang bìa', found: 0, taps: 0, scanTimeouts: 0 },
            { pageId: p2, pageNumber: 2, title: null, found: 2, taps: 1, scanTimeouts: 0 },
            { pageId: p3, pageNumber: 3, title: 'Cuối', found: 1, taps: 3, scanTimeouts: 0 },
        ]);
    });

    it('follows the order of the pages as it is now', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const p1 = await addPage(a, bookId);
        const p2 = await addPage(a, bookId);
        await pool.query(
            `UPDATE pages SET order_index = CASE id WHEN $1 THEN 1 ELSE 0 END WHERE book_id = $3 AND id IN ($1, $2)`,
            [p1, p2, bookId],
        );
        const { byPage } = await bookStats(a.id, bookId, { range: '30d' }, NOW);
        expect(byPage.map((p) => [p.pageId, p.pageNumber])).toEqual([
            [p2, 1],
            [p1, 2],
        ]);
    });

    it('ignores events of a page that was deleted', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const keep = await addPage(a, bookId);
        const gone = await addPage(a, bookId);
        await addEvents(bookId, [
            { event: 'PAGE_FOUND', page: gone },
            { event: 'PAGE_FOUND', page: keep },
        ]);
        await pool.query('DELETE FROM pages WHERE id = $1', [gone]);
        const stats = await bookStats(a.id, bookId, { range: '30d' }, NOW);
        expect(stats.byPage).toHaveLength(1);
        expect(stats.byPage[0]?.found).toBe(1);
    });

    it('counts readers by device and system, most first', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const same = randomUUID();
        await addEvents(bookId, [
            { event: 'OPEN', session: same, device: ['mobile', 'Android'] },
            { event: 'TAP', session: same, device: ['mobile', 'Android'] },
            { event: 'OPEN', device: ['mobile', 'Android'] },
            { event: 'OPEN', device: ['mobile', 'iOS'] },
            { event: 'OPEN', device: ['mobile', 'iOS'] },
            { event: 'OPEN', device: ['mobile', 'iOS'] },
            { event: 'OPEN', device: ['desktop', 'Windows'] },
        ]);
        const { byDevice } = await bookStats(a.id, bookId, { range: '30d' }, NOW);
        expect(byDevice).toEqual([
            { type: 'mobile', os: 'iOS', count: 3 },
            { type: 'mobile', os: 'Android', count: 2 },
            { type: 'desktop', os: 'Windows', count: 1 },
        ]);
    });

    it('leaves out events with no device', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        await addEvents(bookId, [{ event: 'OPEN', device: null }]);
        const stats = await bookStats(a.id, bookId, { range: '30d' }, NOW);
        expect(stats.byDevice).toEqual([]);
        expect(stats.totals.opens).toBe(1);
    });

    it('counts only this book', async () => {
        const a = await signUp();
        const mine = await newBook(a);
        const other = await newBook(a, 'Sách khác');
        const page = await addPage(a, other);
        const mine1 = await addPage(a, mine);
        await addEvents(other, [{ event: 'OPEN' }, { event: 'TAP', page }]);
        await addEvents(mine, [{ event: 'OPEN' }]);
        const stats = await bookStats(a.id, mine, { range: '30d' }, NOW);
        expect(stats.totals).toMatchObject({ opens: 1, taps: 0 });
        // Only the pages of this book are listed, with only their own events.
        expect(stats.byPage.map((p) => [p.pageId, p.taps])).toEqual([[mine1, 0]]);
    });

    it('counts events of every version of the book', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const versions: string[] = [];
        for (const n of [1, 2]) {
            const v = await pool.query(
                `INSERT INTO book_versions (book_id, version_no, schema_version, manifest_public_id,
                                    mind_groups, page_count, ar_page_count, total_size_bytes)
         VALUES ($1, $2, 1, 'm', '[]', 1, 1, 1) RETURNING id`,
                [bookId, n],
            );
            versions.push(v.rows[0].id);
        }
        for (const v of versions) {
            await pool.query(
                `INSERT INTO view_events (book_id, book_version_id, event, session_id) VALUES ($1, $2, 'OPEN', $3)`,
                [bookId, v, randomUUID()],
            );
        }
        expect((await bookStats(a.id, bookId, { range: '30d' })).totals.opens).toBe(2);
    });

    it('answers 404 for a book of someone else, an unknown book, and an id that is not a UUID', async () => {
        const a = await signUp();
        const b = await signUp();
        const bookId = await newBook(a);
        for (const [who, id] of [
            [b, bookId],
            [a, UNKNOWN_ID],
            [a, 'khong-phai-uuid'],
        ] as const) {
            const res = await get(who, id);
            expect(res.status, id).toBe(404);
            expect(res.body.error.code).toBe('NOT_FOUND');
        }
    });

    it('answers 404 for a book in the trash', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        await pool.query('UPDATE books SET deleted_at = now() WHERE id = $1', [bookId]);
        expect((await get(a, bookId)).status).toBe(404);
    });

    it('needs a signed-in author', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const res = await request(app).get(`/api/v1/books/${bookId}/stats`);
        expect(res.status).toBe(401);
    });

    it('rejects a range that is not offered', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        for (const q of ['?range=1d', '?range=365d', '?range=week']) {
            const res = await get(a, bookId, q);
            expect(res.status, q).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
    });

    it('never reveals anything that identifies a reader', async () => {
        const a = await signUp();
        const bookId = await newBook(a);
        const session = randomUUID();
        await addEvents(bookId, [{ event: 'OPEN', session }]);
        const res = await get(a, bookId);
        expect(JSON.stringify(res.body)).not.toContain(session);
    });
});
