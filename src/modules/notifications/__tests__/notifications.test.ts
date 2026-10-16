import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool, withTransaction } from '../../../db';
import { JobTypeSchema, NotificationSchema, NotificationTypeSchema } from '../../../schema';
import { buildNotification } from '../notifications.repository';
import { notificationsService } from '../notifications.service';
import type { NotificationEvent } from '../notifications.types';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const notify = notificationsService.notify;
const BOOK = '11111111-1111-4111-8111-111111111111';

const signUp = async () => {
    const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
            displayName: 'Tác giả',
            email: `notice-${randomUUID()}@example.com`,
            password: 'Matkhau-123',
        });
    return { id: res.body.data.user.id as string, token: res.body.data.accessToken as string };
};

const EVENTS: NotificationEvent[] = [
    { type: 'JOB_SUCCEEDED', job: 'PUBLISH_BOOK', bookId: BOOK, bookTitle: 'Khủng long' },
    { type: 'JOB_FAILED', job: 'PUBLISH_BOOK', bookId: BOOK, bookTitle: 'Khủng long' },
    { type: 'BOOK_TAKEN_DOWN', bookId: BOOK, bookTitle: 'Khủng long', reason: 'Vi phạm bản quyền' },
    { type: 'BOOK_REINSTATED', bookId: BOOK, bookTitle: 'Khủng long' },
    { type: 'ACCOUNT_LOCKED', reason: 'Spam' },
    { type: 'ACCOUNT_UNLOCKED' },
];

describe('buildNotification', () => {
    it('has a message for every type the backend emits', () => {
        const made = EVENTS.map((e) => buildNotification(e).type).sort();
        expect(made).toEqual([...NotificationTypeSchema.options].sort());
    });

    it('says what finished, for which book, and links to the book', () => {
        const ok = buildNotification(EVENTS[0] as NotificationEvent);
        expect(ok).toEqual({
            type: 'JOB_SUCCEEDED',
            title: 'Xuất bản xong',
            body: 'Sách “Khủng long”: xuất bản đã hoàn tất.',
            link: `/books/${BOOK}`,
        });
    });

    it('says a failed job left the book as it was', () => {
        const bad = buildNotification(EVENTS[1] as NotificationEvent);
        expect(bad.title).toBe('Xuất bản không thành công');
        expect(bad.body).toContain('giữ nguyên');
        expect(bad.link).toBe(`/books/${BOOK}`);
    });

    it('names every kind of job differently', () => {
        const titles = JobTypeSchema.options.map(
            (job) =>
                buildNotification({ type: 'JOB_SUCCEEDED', job, bookId: BOOK, bookTitle: 'x' })
                    .title,
        );
        expect(new Set(titles).size).toBe(JobTypeSchema.options.length);
    });

    it('gives the reason of a take-down in the body, not the title', () => {
        const n = buildNotification(EVENTS[2] as NotificationEvent);
        expect(n.title).toBe('Sách “Khủng long” đã bị gỡ');
        expect(n.body).toBe('Lý do: Vi phạm bản quyền');
        expect(n.link).toBe(`/books/${BOOK}`);
    });

    it('tells the author a reinstated book is private again', () => {
        const n = buildNotification(EVENTS[3] as NotificationEvent);
        expect(n.title).toBe('Sách “Khủng long” đã được khôi phục');
        expect(n.body).toContain('Riêng tư');
    });

    it('has no link for account notices, and a reason only when there is one', () => {
        expect(buildNotification(EVENTS[4] as NotificationEvent)).toMatchObject({
            link: null,
            body: 'Lý do: Spam',
        });
        expect(buildNotification({ type: 'ACCOUNT_LOCKED' }).body).toBeNull();
        expect(buildNotification(EVENTS[5] as NotificationEvent)).toMatchObject({
            title: 'Tài khoản của bạn đã được mở khoá',
            body: null,
            link: null,
        });
    });

    it('keeps every title within the 150 characters of the column', () => {
        const long = 'x'.repeat(300);
        for (const type of ['BOOK_TAKEN_DOWN', 'BOOK_REINSTATED'] as const) {
            const n = buildNotification(
                type === 'BOOK_TAKEN_DOWN'
                    ? { type, bookId: BOOK, bookTitle: long, reason: 'r' }
                    : { type, bookId: BOOK, bookTitle: long },
            );
            expect(n.title.length).toBe(150);
            expect(n.title.endsWith('…')).toBe(true);
        }
        // A title of exactly 150 characters is kept whole; one more character and it is cut.
        const fits = 150 - 'Sách “” đã bị gỡ'.length;
        const title = (bookTitle: string) =>
            buildNotification({ type: 'BOOK_TAKEN_DOWN', bookId: BOOK, bookTitle, reason: 'r' })
                .title;
        expect(title('y'.repeat(fits))).toBe(`Sách “${'y'.repeat(fits)}” đã bị gỡ`);
        expect(title('y'.repeat(fits + 1))).toHaveLength(150);
        expect(title('y'.repeat(fits + 1)).endsWith('…')).toBe(true);
    });
});

suite('notify', () => {
    it('stores the notification, unread, for that user only', async () => {
        const a = await signUp();
        const b = await signUp();
        const id = await notify(pool, a.id, EVENTS[2] as NotificationEvent);
        const rows = (await pool.query('SELECT * FROM notifications WHERE user_id = $1', [a.id]))
            .rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id,
            user_id: a.id,
            type: 'BOOK_TAKEN_DOWN',
            title: 'Sách “Khủng long” đã bị gỡ',
            body: 'Lý do: Vi phạm bản quyền',
            link: `/books/${BOOK}`,
            read_at: null,
        });
        const other = await request(app)
            .get('/api/v1/me/notifications')
            .set('Authorization', `Bearer ${b.token}`);
        expect(other.body.data).toEqual([]);
    });

    it('shows up in GET /me/notifications, newest first, and can be marked read', async () => {
        const a = await signUp();
        const h = { Authorization: `Bearer ${a.token}` };
        const first = await notify(pool, a.id, EVENTS[0] as NotificationEvent);
        await pool.query(
            "UPDATE notifications SET created_at = now() - interval '1 minute' WHERE id = $1",
            [first],
        );
        const second = await notify(pool, a.id, EVENTS[1] as NotificationEvent);
        const res = await request(app).get('/api/v1/me/notifications').set(h);
        expect(res.status).toBe(200);
        const list = res.body.data.map((n: unknown) => NotificationSchema.parse(n));
        expect(list.map((n: { type: string }) => n.type)).toEqual(['JOB_FAILED', 'JOB_SUCCEEDED']);
        expect(list[0].id).toBe(second);
        await request(app)
            .post('/api/v1/me/notifications/read')
            .set(h)
            .send({ ids: [second] });
        const unread = await request(app).get('/api/v1/me/notifications?unread=true').set(h);
        expect(unread.body.data.map((n: { type: string }) => n.type)).toEqual(['JOB_SUCCEEDED']);
    });

    it('is written in the caller transaction: rolled back with the change it reports', async () => {
        const a = await signUp();
        await expect(
            withTransaction(async (db) => {
                await notify(db, a.id, EVENTS[0] as NotificationEvent);
                throw new Error('the change failed');
            }),
        ).rejects.toThrow('the change failed');
        expect(
            (await pool.query('SELECT 1 FROM notifications WHERE user_id = $1', [a.id])).rows,
        ).toHaveLength(0);
        await withTransaction((db) => notify(db, a.id, EVENTS[0] as NotificationEvent));
        expect(
            (await pool.query('SELECT 1 FROM notifications WHERE user_id = $1', [a.id])).rows,
        ).toHaveLength(1);
    });

    it('fails for a user that does not exist', async () => {
        await expect(
            notify(pool, '00000000-0000-4000-8000-000000000000', EVENTS[5] as NotificationEvent),
        ).rejects.toThrow();
    });
});
