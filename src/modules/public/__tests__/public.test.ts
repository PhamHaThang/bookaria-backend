import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool, type Queryable } from '../../../db';
import { type MediaStorage, setMediaStorage } from '../../../lib';
import { AuthorProfileSchema, PublicBookCardSchema, PublicBookSchema } from '../../../schema';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const row = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

const fakeStorage: MediaStorage = {
    signUpload: () => {
        throw new Error('Unused in public tests');
    },
    inspect: async () => null,
    destroy: async () => {},
    deliveryUrl: ({ resourceType, publicId, transform }) =>
        `https://media.test/${resourceType}/${transform ? `${transform}/` : ''}${publicId}`,
};

async function insertRecord(
    db: Queryable,
    table: 'users' | 'books' | 'assets',
    values: Record<string, unknown>,
): Promise<{ id: string }> {
    const columns = Object.keys(values);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const result = await db.query<{ id: string }>(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
        Object.values(values),
    );
    return result.rows[0] as { id: string };
}

async function insertUser(db: Queryable, overrides: Record<string, unknown> = {}) {
    return insertRecord(db, 'users', {
        email: `publictest-${randomUUID()}@example.com`,
        password_hash: 'test',
        display_name: 'Tác giả',
        ...overrides,
    });
}

async function insertBook(
    db: Queryable,
    authorId: string,
    overrides: Record<string, unknown> = {},
) {
    return insertRecord(db, 'books', {
        owner_id: authorId,
        title: 'Sách thử nghiệm',
        ...overrides,
    });
}

async function insertAsset(db: Queryable, overrides: Record<string, unknown> = {}) {
    return insertRecord(db, 'assets', {
        type: 'IMAGE',
        name: 'Ảnh thử nghiệm',
        original_public_id: `publictest/${randomUUID()}`,
        resource_type: 'image',
        format: 'png',
        size_bytes: 1000,
        status: 'READY',
        ...overrides,
    });
}

async function insertPage(db: Queryable, bookId: string, imageId: string): Promise<{ id: string }> {
    const result = await db.query<{ id: string }>(
        `INSERT INTO pages (book_id, order_index, image_asset_id, marker_mode, marker_mind_public_id, marker_score)
     VALUES ($1, 0, $2, 'CUSTOM_MARKER', 'publictest/marker.mind', 3) RETURNING id`,
        [bookId, imageId],
    );
    return result.rows[0] as { id: string };
}

async function resetPublicFixtures() {
    await pool.query(
        "DELETE FROM books WHERE owner_id IN (SELECT id FROM users WHERE email LIKE 'publictest-%@example.com')",
    );
}

afterAll(async () => {
    setMediaStorage(undefined);
    if (!process.env.SKIP_DB_TESTS) await resetPublicFixtures();
});
beforeEach(async () => {
    await resetPublicFixtures();
    setMediaStorage(fakeStorage);
});

let seq = 0;

interface Shelf {
    authorId: string;
    bookId: string;
    slug: string;
    versionId: string;
    pageId: string;
}

/** A book as the publish worker leaves it: a slug, a current version, one AR page. */
const shelve = async (
    o: {
        authorId?: string;
        book?: Record<string, unknown>;
        version?: Record<string, unknown>;
        author?: Record<string, unknown>;
    } = {},
): Promise<Shelf> => {
    const client = await pool.connect();
    try {
        const authorId = o.authorId ?? (await insertUser(client, o.author ?? {})).id;
        const n = ++seq;
        const slug = `sach-${n}-x7k2`;
        const book = await insertBook(client, authorId, {
            slug,
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
            first_published_at: new Date(Date.UTC(2026, 0, n)),
            ...o.book,
        });
        const image = (await insertAsset(client, { owner_id: authorId })).id;
        const page = await insertPage(client, book.id, image);
        const version = (
            await client.query(
                `INSERT INTO book_versions (book_id, version_no, schema_version, manifest_public_id,
                                    mind_groups, page_count, ar_page_count, total_size_bytes)
         VALUES ($1, 1, 1, $2, '[]', 3, 2, $3) RETURNING id`,
                [book.id, `manifests/${slug}.json`, 1234567],
            )
        ).rows[0];
        await client.query('UPDATE books SET current_version_id = $2 WHERE id = $1', [
            book.id,
            version.id,
        ]);
        return { authorId, bookId: book.id, slug, versionId: version.id, pageId: page.id };
    } finally {
        client.release();
    }
};

const get = (path: string) => request(app).get(`/api/v1/public${path}`);
const slugsOf = (res: { body: { data: { slug: string }[] } }) => res.body.data.map((b) => b.slug);

// ---------------------------------------------------------------------------------------------
suite('GET /public/books/:slug', () => {
    it('shows the book with the address of its manifest, with no sign-in', async () => {
        const s = await shelve({ book: { description: 'Về khủng long', age_min: 4, age_max: 8 } });
        const res = await get(`/books/${s.slug}`);
        expect(res.status).toBe(200);
        const book = PublicBookSchema.parse(res.body.data);
        expect(book).toMatchObject({
            slug: s.slug,
            description: 'Về khủng long',
            ageMin: 4,
            ageMax: 8,
            language: 'vi',
            pageCount: 3,
            arPageCount: 2,
            downloadBytes: 1234567,
            printPdfUrl: null,
            version: { id: s.versionId, versionNo: 1 },
            manifestUrl: `https://media.test/raw/manifests/${s.slug}.json`,
        });
        expect(book.author.id).toBe(s.authorId);
        expect(book.coverUrl).toBeNull();
    });

    it('lets a browser keep the answer for a minute', async () => {
        const s = await shelve();
        const res = await get(`/books/${s.slug}`);
        expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('shows an UNLISTED book to anyone who has the link', async () => {
        const s = await shelve({ book: { visibility: 'UNLISTED' } });
        expect((await get(`/books/${s.slug}`)).status).toBe(200);
    });

    it('gives the address of the cover and of the print PDF when they exist', async () => {
        const author = await insertUser(pool);
        const cover = await insertAsset(pool, {
            owner_id: author.id,
            original_public_id: 'u/cover1',
        });
        const s = await shelve({ authorId: author.id, book: { cover_asset_id: cover.id } });
        await pool.query('UPDATE book_versions SET print_pdf_public_id = $2 WHERE id = $1', [
            s.versionId,
            'pdf/sach.pdf',
        ]);
        const res = await get(`/books/${s.slug}`);
        expect(res.body.data.coverUrl).toBe(
            'https://media.test/image/c_fill,w_320,h_320,q_auto,f_auto/u/cover1',
        );
        expect(res.body.data.printPdfUrl).toBe('https://media.test/raw/pdf/sach.pdf');
    });

    it('does not show a deleted cover', async () => {
        const author = await insertUser(pool);
        const cover = await insertAsset(pool, { owner_id: author.id });
        const s = await shelve({ authorId: author.id, book: { cover_asset_id: cover.id } });
        await pool.query('UPDATE assets SET deleted_at = now() WHERE id = $1', [cover.id]);
        expect((await get(`/books/${s.slug}`)).body.data.coverUrl).toBeNull();
    });

    it('answers 404 for a slug nobody has had, however it is spelled', async () => {
        await shelve();
        for (const slug of ['khong-co-sach-nay', 'A', 'x'.repeat(200), 'co%20dau']) {
            const res = await get(`/books/${slug}`);
            expect(res.status, slug).toBe(404);
            expect(res.body.error.code).toBe('NOT_FOUND');
        }
    });

    it('answers 404 for a draft that was never published (it has no slug)', async () => {
        const client = await pool.connect();
        const author = await insertUser(client);
        await insertBook(client, author.id);
        client.release();
        expect((await get('/books/null')).status).toBe(404);
    });

    it.each([
        ['made private', { visibility: 'PRIVATE' }],
        ['in the trash', { deleted_at: new Date() }],
        [
            'taken down',
            { visibility: 'PRIVATE', taken_down_at: new Date(), taken_down_reason: 'Vi phạm' },
        ],
    ])('answers 410 for a book that is %s', async (_name, book) => {
        const s = await shelve({ book });
        const res = await get(`/books/${s.slug}`);
        expect(res.status).toBe(410);
        expect(res.body.error.code).toBe('BOOK_UNAVAILABLE');
    });

    it('answers 410 while the author is locked', async () => {
        const s = await shelve({ author: { status: 'LOCKED' } });
        expect((await get(`/books/${s.slug}`)).status).toBe(410);
    });

    it('shows the newest version once the book points at it', async () => {
        const s = await shelve();
        const v2 = await row(
            `INSERT INTO book_versions (book_id, version_no, schema_version, manifest_public_id,
                                  mind_groups, page_count, ar_page_count, total_size_bytes)
       VALUES ($1, 2, 1, 'manifests/v2.json', '[]', 5, 4, 99) RETURNING id`,
            [s.bookId],
        );
        await pool.query('UPDATE books SET current_version_id = $2 WHERE id = $1', [
            s.bookId,
            v2.id,
        ]);
        const book = (await get(`/books/${s.slug}`)).body.data;
        expect(book.version.versionNo).toBe(2);
        expect(book.pageCount).toBe(5);
        expect(book.downloadBytes).toBe(99);
    });
});

// ---------------------------------------------------------------------------------------------
suite('GET /public/books', () => {
    it('lists only PUBLIC books that are still on show', async () => {
        const shown = await shelve();
        await shelve({ book: { visibility: 'UNLISTED' } });
        await shelve({ book: { visibility: 'PRIVATE' } });
        await shelve({ book: { deleted_at: new Date() } });
        await shelve({
            book: { visibility: 'PRIVATE', taken_down_at: new Date(), taken_down_reason: 'x' },
        });
        await shelve({ author: { status: 'LOCKED' } });
        const res = await get('/books');
        expect(res.status).toBe(200);
        expect(slugsOf(res)).toEqual([shown.slug]);
        expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
        PublicBookCardSchema.parse(res.body.data[0]);
        expect(res.body.data[0].arPageCount).toBe(2);
    });

    it('gives each card its cover, age range and author; a deleted cover is no cover', async () => {
        const client = await pool.connect();
        const author = await insertUser(client, { display_name: 'Cô Lan' });
        const cover = await insertAsset(client, {
            owner_id: author.id,
            original_public_id: 'u/bia1',
        });
        const gone = await insertAsset(client, { owner_id: author.id });
        client.release();
        const withCover = await shelve({
            authorId: author.id,
            book: { cover_asset_id: cover.id, age_min: 4, age_max: 9 },
        });
        const noCover = await shelve({ authorId: author.id, book: { cover_asset_id: gone.id } });
        await pool.query('UPDATE assets SET deleted_at = now() WHERE id = $1', [gone.id]);
        const cards = (await get('/books')).body.data;
        const bySlug = (slug: string) => cards.find((c: { slug: string }) => c.slug === slug);
        expect(bySlug(withCover.slug)).toMatchObject({
            coverUrl: 'https://media.test/image/c_fill,w_320,h_320,q_auto,f_auto/u/bia1',
            ageMin: 4,
            ageMax: 9,
            author: { id: author.id, displayName: 'Cô Lan' },
        });
        expect(bySlug(noCover.slug).coverUrl).toBeNull();
    });

    it('puts the newest published book first and pages through the list', async () => {
        const a = await shelve();
        const b = await shelve();
        const c = await shelve();
        const first = await get('/books?limit=2');
        expect(slugsOf(first)).toEqual([c.slug, b.slug]);
        expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
        const second = await get('/books?limit=2&page=2');
        expect(slugsOf(second)).toEqual([a.slug]);
        expect(second.body.meta.total).toBe(3);
        expect(slugsOf(await get('/books?limit=2&page=3'))).toEqual([]);
    });

    it('sorts by popularity when asked', async () => {
        const a = await shelve({ book: { view_count: 5 } });
        const b = await shelve({ book: { view_count: 50 } });
        const c = await shelve({ book: { view_count: 20 } });
        expect(slugsOf(await get('/books?sort=popular'))).toEqual([b.slug, c.slug, a.slug]);
        expect(slugsOf(await get('/books?sort=newest'))).toEqual([c.slug, b.slug, a.slug]);
    });

    it('searches the title without minding case, and treats % and _ as plain letters', async () => {
        const a = await shelve({ book: { title: 'Khám phá Khủng Long' } });
        await shelve({ book: { title: 'Vũ trụ' } });
        const hundred = await shelve({ book: { title: 'Giảm 100% giá' } });
        await shelve({ book: { title: 'Giảm 1000 giá' } });
        expect(slugsOf(await get(`/books?q=${encodeURIComponent('khủng long')}`))).toEqual([
            a.slug,
        ]);
        expect(slugsOf(await get(`/books?q=${encodeURIComponent('100%')}`))).toEqual([
            hundred.slug,
        ]);
        expect(slugsOf(await get('/books?q=_'))).toEqual([]);
    });

    it('keeps the books that suit an age; a missing limit suits every age on that side', async () => {
        const small = await shelve({ book: { age_min: 3, age_max: 5 } });
        const big = await shelve({ book: { age_min: 8, age_max: 12 } });
        const open = await shelve({ book: {} });
        const noMax = await shelve({ book: { age_min: 6 } });
        const noMin = await shelve({ book: { age_max: 6 } });
        const sorted = async (age: number) => slugsOf(await get(`/books?age=${age}`)).sort();
        expect(await sorted(4)).toEqual([small.slug, open.slug, noMin.slug].sort());
        expect(await sorted(6)).toEqual([open.slug, noMax.slug, noMin.slug].sort());
        expect(await sorted(5)).toEqual([small.slug, open.slug, noMin.slug].sort());
        expect(await sorted(10)).toEqual([big.slug, open.slug, noMax.slug].sort());
        expect(await sorted(0)).toEqual([open.slug, noMin.slug].sort());
    });

    it('keeps one topic and one language', async () => {
        const a = await shelve({ book: { topic: 'khoa-hoc', language: 'vi' } });
        const b = await shelve({ book: { topic: 'khoa-hoc', language: 'en' } });
        await shelve({ book: { topic: 'co-tich', language: 'vi' } });
        expect(slugsOf(await get('/books?topic=khoa-hoc')).sort()).toEqual([a.slug, b.slug].sort());
        expect(slugsOf(await get('/books?language=en'))).toEqual([b.slug]);
        expect(slugsOf(await get('/books?topic=khoa-hoc&language=vi'))).toEqual([a.slug]);
    });

    it('counts the total of the whole filter, not of the page', async () => {
        for (let i = 0; i < 3; i += 1) await shelve({ book: { topic: 'a' } });
        await shelve({ book: { topic: 'b' } });
        const res = await get('/books?topic=a&limit=1');
        expect(res.body.data).toHaveLength(1);
        expect(res.body.meta.total).toBe(3);
    });

    it('rejects a bad query with 400', async () => {
        for (const q of [
            'age=19',
            'age=x',
            'sort=best',
            'limit=0',
            'limit=101',
            'language=xx-yy-zz',
        ]) {
            const res = await get(`/books?${q}`);
            expect(res.status, q).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
    });
});

// ---------------------------------------------------------------------------------------------
suite('GET /public/authors/:authorId', () => {
    it('shows the profile and the public books, never the email', async () => {
        const s = await shelve({
            author: {
                display_name: 'Cô Lan',
                organization: 'Nhà sách A',
                bio: 'Viết cho bé',
                avatar_url: 'https://media.test/avatar/lan.png',
            },
        });
        await shelve({ authorId: s.authorId });
        await shelve({ authorId: s.authorId, book: { visibility: 'UNLISTED' } });
        await shelve({ authorId: s.authorId, book: { visibility: 'PRIVATE' } });
        await shelve({ authorId: s.authorId, book: { deleted_at: new Date() } });
        await shelve(); // someone else's
        const res = await get(`/authors/${s.authorId}`);
        expect(res.status).toBe(200);
        const profile = AuthorProfileSchema.parse(res.body.data);
        expect(profile.author).toEqual({
            id: s.authorId,
            displayName: 'Cô Lan',
            organization: 'Nhà sách A',
            bio: 'Viết cho bé',
            avatarUrl: 'https://media.test/avatar/lan.png',
        });
        expect(profile.books).toHaveLength(2);
        expect(profile.books[0]?.slug).not.toBe(s.slug);
        expect(JSON.stringify(res.body)).not.toContain('@');
    });

    it('answers 404 for an author with no book on show, a locked one, and an unknown id', async () => {
        const client = await pool.connect();
        const nobody = await insertUser(client);
        client.release();
        const hidden = await shelve({ book: { visibility: 'PRIVATE' } });
        const locked = await shelve({ author: { status: 'LOCKED' } });
        for (const id of [
            nobody.id,
            hidden.authorId,
            locked.authorId,
            UNKNOWN_ID,
            'khong-phai-uuid',
        ]) {
            const res = await get(`/authors/${id}`);
            expect(res.status, id).toBe(404);
        }
    });
});

// ---------------------------------------------------------------------------------------------
suite('POST /public/events', () => {
    const at = '2026-10-14T10:00:00.000Z';
    const device = { type: 'mobile', os: 'Android', browser: 'Chrome' };
    const batch = (s: Shelf, events: unknown[], extra: Record<string, unknown> = {}) => ({
        sessionId: randomUUID(),
        bookVersionId: s.versionId,
        device,
        events,
        ...extra,
    });
    const send = (body: unknown) =>
        request(app)
            .post('/api/v1/public/events')
            .send(body as object);
    const stored = () =>
        rows(`SELECT ve.* FROM view_events ve
              JOIN books b ON b.id = ve.book_id
              JOIN users u ON u.id = b.owner_id
              WHERE u.email LIKE 'publictest-%@example.com'
              ORDER BY ve.id`);

    it('accepts a batch with 202 and no body, and keeps each event', async () => {
        const s = await shelve();
        const sessionId = randomUUID();
        const res = await send(
            batch(
                s,
                [
                    { type: 'OPEN', at },
                    { type: 'PAGE_FOUND', pageId: s.pageId, at },
                    { type: 'TAP', pageId: s.pageId, objectId: 'obj_1', at },
                    { type: 'SCAN_TIMEOUT', at },
                ],
                { sessionId },
            ),
        );
        expect(res.status).toBe(202);
        expect(res.text).toBe('');
        const events = await stored();
        expect(events.map((e) => e.event)).toEqual(['OPEN', 'PAGE_FOUND', 'TAP', 'SCAN_TIMEOUT']);
        expect(events.map((e) => e.page_id)).toEqual([null, s.pageId, s.pageId, null]);
        expect(events.map((e) => e.object_id)).toEqual([null, null, 'obj_1', null]);
        for (const e of events) {
            expect(e).toMatchObject({
                book_id: s.bookId,
                book_version_id: s.versionId,
                session_id: sessionId,
                device_type: 'mobile',
                os: 'Android',
                browser: 'Chrome',
            });
        }
    });

    it('uses the time of the server, not the time the device says', async () => {
        const s = await shelve();
        await send(batch(s, [{ type: 'OPEN', at: '2001-01-01T00:00:00.000Z' }]));
        const e = (await stored())[0];
        expect(Date.now() - e.created_at.getTime()).toBeLessThan(60_000);
    });

    it('counts every OPEN as a view of the book', async () => {
        const s = await shelve();
        const other = await shelve();
        await send(
            batch(s, [
                { type: 'OPEN', at },
                { type: 'OPEN', at },
                { type: 'SCAN_TIMEOUT', at },
            ]),
        );
        expect(
            (await row('SELECT view_count FROM books WHERE id = $1', [s.bookId])).view_count,
        ).toBe('2');
        expect(
            (await row('SELECT view_count FROM books WHERE id = $1', [other.bookId])).view_count,
        ).toBe('0');
    });

    it('does not make a published book look changed', async () => {
        const s = await shelve();
        // Adding the page in `shelve` already made the book CHANGED; start from PUBLISHED.
        await pool.query("UPDATE books SET status = 'PUBLISHED' WHERE id = $1", [s.bookId]);
        const before = await row('SELECT updated_at FROM books WHERE id = $1', [s.bookId]);
        await send(batch(s, [{ type: 'OPEN', at }]));
        const after = await row('SELECT status, updated_at FROM books WHERE id = $1', [s.bookId]);
        expect(after.status).toBe('PUBLISHED');
        expect(after.updated_at).toEqual(before.updated_at);
    });

    it('drops a malformed event without a word and keeps the others', async () => {
        const s = await shelve();
        const res = await send(
            batch(s, [
                { type: 'OPEN', at },
                { type: 'TAP', pageId: s.pageId, at }, // no objectId
                { type: 'DANCE', at },
                'text',
                null,
                { type: 'OPEN', at: 'hôm qua' },
            ]),
        );
        expect(res.status).toBe(202);
        expect((await stored()).map((e) => e.event)).toEqual(['OPEN']);
    });

    it('drops events of a page that is not in the book', async () => {
        const s = await shelve();
        const other = await shelve();
        const res = await send(
            batch(s, [
                { type: 'PAGE_FOUND', pageId: other.pageId, at },
                { type: 'PAGE_FOUND', pageId: UNKNOWN_ID, at },
                { type: 'PAGE_FOUND', pageId: s.pageId, at },
            ]),
        );
        expect(res.status).toBe(202);
        const events = await stored();
        expect(events).toHaveLength(1);
        expect(events[0].page_id).toBe(s.pageId);
    });

    it('answers 202 and stores nothing for a version that does not exist', async () => {
        const s = await shelve();
        const res = await send(batch(s, [{ type: 'OPEN', at }], { bookVersionId: UNKNOWN_ID }));
        expect(res.status).toBe(202);
        expect(await stored()).toHaveLength(0);
    });

    it.each([
        ['made private', { visibility: 'PRIVATE' }],
        ['in the trash', { deleted_at: new Date() }],
        [
            'taken down',
            { visibility: 'PRIVATE', taken_down_at: new Date(), taken_down_reason: 'x' },
        ],
    ])('answers 202 and stores nothing for a book that is %s', async (_name, book) => {
        const s = await shelve({ book });
        const res = await send(batch(s, [{ type: 'OPEN', at }]));
        expect(res.status).toBe(202);
        expect(await stored()).toHaveLength(0);
    });

    it('stores events of an UNLISTED book', async () => {
        const s = await shelve({ book: { visibility: 'UNLISTED' } });
        await send(batch(s, [{ type: 'OPEN', at }]));
        expect(await stored()).toHaveLength(1);
    });

    it('keeps events of a version that is no longer the current one', async () => {
        const s = await shelve();
        const v2 = await row(
            `INSERT INTO book_versions (book_id, version_no, schema_version, manifest_public_id,
                                  mind_groups, page_count, ar_page_count, total_size_bytes)
       VALUES ($1, 2, 1, 'm2', '[]', 1, 1, 1) RETURNING id`,
            [s.bookId],
        );
        await pool.query('UPDATE books SET current_version_id = $2 WHERE id = $1', [
            s.bookId,
            v2.id,
        ]);
        await send(batch(s, [{ type: 'OPEN', at }]));
        expect((await stored())[0].book_version_id).toBe(s.versionId);
    });

    it('rejects a broken batch with 400 and stores nothing', async () => {
        const s = await shelve();
        const good = batch(s, [{ type: 'OPEN', at }]);
        const bad: Record<string, unknown>[] = [
            { ...good, events: [] },
            { ...good, events: [{ type: 'DANCE', at }] },
            { ...good, events: Array.from({ length: 51 }, () => ({ type: 'OPEN', at })) },
            { ...good, sessionId: 'abc' },
            { ...good, bookVersionId: 'abc' },
            { ...good, device: { type: 'toaster', os: 'x', browser: 'y' } },
            { ...good, device: { type: 'mobile', os: 'x'.repeat(21), browser: 'y' } },
            { sessionId: good.sessionId },
        ];
        for (const body of bad) {
            const res = await send(body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        expect(await stored()).toHaveLength(0);
    });

    it('takes a full batch of 50', async () => {
        const s = await shelve();
        const res = await send(
            batch(
                s,
                Array.from({ length: 50 }, () => ({ type: 'OPEN', at })),
            ),
        );
        expect(res.status).toBe(202);
        expect(await stored()).toHaveLength(50);
    });

    it('limits one client to 60 batches a minute when limits are on', async () => {
        const limited = createApp({ rateLimit: true });
        let last = 0;
        for (let i = 0; i < 61; i += 1) {
            last = (await request(limited).post('/api/v1/public/events').send({})).status;
        }
        expect(last).toBe(429);
    });
});

// ---------------------------------------------------------------------------------------------
suite('POST /public/books/:slug/reports', () => {
    const body = (extra: Record<string, unknown> = {}) => ({
        reason: 'INAPPROPRIATE',
        deviceId: 'thiet-bi-0001',
        ...extra,
    });
    const report = (slug: string, b: unknown) =>
        request(app)
            .post(`/api/v1/public/books/${slug}/reports`)
            .send(b as object);
    const stored = () => rows('SELECT * FROM reports ORDER BY created_at');

    it('records the report with 201 and keeps only a fingerprint of the device', async () => {
        const s = await shelve();
        const res = await report(
            s.slug,
            body({ note: '  Hình ảnh không phù hợp  ', pageId: s.pageId }),
        );
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ data: { received: true } });
        const [r] = await stored();
        expect(r).toMatchObject({
            book_id: s.bookId,
            page_id: s.pageId,
            reason: 'INAPPROPRIATE',
            note: 'Hình ảnh không phù hợp',
            status: 'OPEN',
        });
        expect(r.reporter_fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(r.reporter_fingerprint).not.toContain('thiet-bi-0001');
    });

    it('stores no note when there is none, or only blanks', async () => {
        const s = await shelve();
        await report(s.slug, body());
        await report(s.slug, body({ deviceId: 'thiet-bi-0002', note: '   ' }));
        expect((await stored()).map((r) => r.note)).toEqual([null, null]);
    });

    it('gives the same device the same fingerprint, and another device another', async () => {
        const a = await shelve();
        const b = await shelve();
        await report(a.slug, body());
        await report(b.slug, body());
        await report(a.slug, body({ deviceId: 'thiet-bi-0002' }));
        const prints = (await stored()).map((r) => r.reporter_fingerprint);
        expect(prints[0]).toBe(prints[1]);
        expect(prints[2]).not.toBe(prints[0]);
    });

    it('answers 429 when the same device reports the same book again within 24 hours', async () => {
        const s = await shelve();
        expect((await report(s.slug, body())).status).toBe(201);
        const again = await report(s.slug, body({ reason: 'COPYRIGHT' }));
        expect(again.status).toBe(429);
        expect(again.body.error.code).toBe('RATE_LIMITED');
        const wait = again.body.error.details.retryAfterSeconds;
        expect(wait).toBeGreaterThan(24 * 3600 - 60);
        expect(wait).toBeLessThanOrEqual(24 * 3600);
        expect(await stored()).toHaveLength(1);
    });

    it('lets the same device report another book, and another device the same book', async () => {
        const a = await shelve();
        const b = await shelve();
        expect((await report(a.slug, body())).status).toBe(201);
        expect((await report(b.slug, body())).status).toBe(201);
        expect((await report(a.slug, body({ deviceId: 'thiet-bi-0002' }))).status).toBe(201);
    });

    it('lets the device report again after 24 hours', async () => {
        const s = await shelve();
        await report(s.slug, body());
        await pool.query(`UPDATE reports SET created_at = now() - interval '25 hours'`);
        expect((await report(s.slug, body())).status).toBe(201);
        await pool.query(`UPDATE reports SET created_at = now() - interval '23 hours' WHERE id IN
      (SELECT id FROM reports ORDER BY created_at DESC LIMIT 1)`);
        expect((await report(s.slug, body())).status).toBe(429);
    });

    it('lets only one of two reports sent at the same moment in', async () => {
        const s = await shelve();
        const results = await Promise.all([report(s.slug, body()), report(s.slug, body())]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
        expect(await stored()).toHaveLength(1);
    });

    it('makes a second report of the same device wait for the first one to finish', async () => {
        const s = await shelve();
        const fingerprint = createHash('sha256').update('thiet-bi-0001').digest('hex');
        const holder = await pool.connect();
        try {
            await holder.query('BEGIN');
            // Holds the lock a report of this device on this book would take.
            await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
                `report:${s.bookId}:${fingerprint}`,
            ]);
            let answered = false;
            const pending = report(s.slug, body()).then((r) => {
                answered = true;
                return r;
            });
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(answered).toBe(false);
            await holder.query('COMMIT');
            expect((await pending).status).toBe(201);
        } finally {
            holder.release();
        }
    });

    it('answers 404 for an unknown book and 410 for one that is gone', async () => {
        expect((await report('khong-co-sach', body())).status).toBe(404);
        const priv = await shelve({ book: { visibility: 'PRIVATE' } });
        const res = await report(priv.slug, body());
        expect(res.status).toBe(410);
        expect(res.body.error.code).toBe('BOOK_UNAVAILABLE');
        const trashed = await shelve({ book: { deleted_at: new Date() } });
        expect((await report(trashed.slug, body())).status).toBe(410);
        expect(await stored()).toHaveLength(0);
    });

    it('accepts a report on an UNLISTED book', async () => {
        const s = await shelve({ book: { visibility: 'UNLISTED' } });
        expect((await report(s.slug, body())).status).toBe(201);
    });

    it('rejects a bad body with 400', async () => {
        const s = await shelve();
        const bad: Record<string, unknown>[] = [
            {},
            body({ reason: 'SPAM' }),
            body({ deviceId: 'ngan' }),
            body({ deviceId: 'x'.repeat(101) }),
            body({ note: 'x'.repeat(1001) }),
            body({ pageId: 'abc' }),
        ];
        for (const b of bad) {
            const res = await report(s.slug, b);
            expect(res.status, JSON.stringify(b).slice(0, 60)).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        expect(await stored()).toHaveLength(0);
    });

    it('rejects a page of another book with 400 and does not use up the 24 hours', async () => {
        const s = await shelve();
        const other = await shelve();
        const res = await report(s.slug, body({ pageId: other.pageId }));
        expect(res.status).toBe(400);
        expect(res.body.error.details?.fields?.[0]?.path ?? res.body.error.details).toBeDefined();
        expect((await report(s.slug, body())).status).toBe(201);
    });

    it('limits one client to 20 reports an hour when limits are on', async () => {
        const limited = createApp({ rateLimit: true });
        let last = 0;
        for (let i = 0; i < 21; i += 1) {
            last = (await request(limited).post('/api/v1/public/books/x/reports').send({})).status;
        }
        expect(last).toBe(429);
    });
});
