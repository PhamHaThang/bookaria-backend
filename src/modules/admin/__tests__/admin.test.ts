import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { env } from '../../../config';
import { pool } from '../../../db';
import { adminService } from '../admin.service';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp();
const PASSWORD = 'Matkhau-123';

const uniqueEmail = (prefix: string) =>
    `${prefix.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(prefix: string) {
    const email = uniqueEmail(prefix);
    const response = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, displayName: prefix });
    return {
        email,
        token: response.body.data.accessToken as string,
        userId: response.body.data.user.id as string,
    };
}

async function login(email: string) {
    const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD });
    return response.body.data.accessToken as string;
}

async function createAdmin() {
    const admin = await register('Admin');
    await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.userId]);
    return { ...admin, token: await login(admin.email) };
}

async function createReadyAsset(ownerId: string, name = 'Tài nguyên kiểm thử') {
    const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO assets
            (owner_id, type, name, original_public_id, resource_type, thumbnail_url,
             format, size_bytes, status)
         VALUES ($1, 'IMAGE', $2, $3, 'image', $3, 'jpg', 2048, 'READY')
         RETURNING id`,
        [ownerId, name, `https://example.com/assets/${marker}.jpg`],
    );
    return (rows[0] as { id: string }).id;
}

async function createReportedBook(ownerId: string, reasons = ['COPYRIGHT', 'OTHER']) {
    const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const asset = await pool.query<{ id: string }>(
        `INSERT INTO assets
            (owner_id, type, name, original_public_id, resource_type, thumbnail_url,
             format, size_bytes, status)
         VALUES ($1, 'IMAGE', 'Ảnh trang', $2, 'image', $3, 'jpg', 1024, 'READY')
         RETURNING id`,
        [ownerId, `page-${marker}`, `https://example.com/${marker}.jpg`],
    );
    const assetId = (asset.rows[0] as { id: string }).id;
    const title = `Sách kiểm duyệt ${marker}`;
    const book = await pool.query<{ id: string }>(
        `INSERT INTO books (owner_id, title, description, cover_asset_id, visibility)
         VALUES ($1, $2, 'Mô tả kiểm duyệt', $3, 'PUBLIC') RETURNING id`,
        [ownerId, title, assetId],
    );
    const bookId = (book.rows[0] as { id: string }).id;
    await pool.query(
        `INSERT INTO pages (book_id, order_index, title, image_asset_id, marker_mode)
         VALUES ($1, 0, 'Trang đầu', $2, 'NONE')`,
        [bookId, assetId],
    );
    await pool.query(
        `UPDATE books
         SET status = 'PUBLISHED', slug = $2, first_published_at = now()
         WHERE id = $1`,
        [bookId, `moderation-${marker}`],
    );
    for (const [index, reason] of reasons.entries()) {
        await pool.query(
            `INSERT INTO reports (book_id, reason, note, reporter_fingerprint)
             VALUES ($1, $2, $3, $4)`,
            [bookId, reason, `Báo cáo ${index + 1}`, `${marker}-${index}`],
        );
    }
    return { bookId, title };
}

suite('quản lý người dùng của admin', () => {
    it('chặn tác giả và không tin role ADMIN đã cũ trong access token', async () => {
        const author = await register('Author');
        const forbidden = await request(app).get('/api/v1/admin/users').set(bearer(author.token));
        expect(forbidden.status).toBe(403);

        await createAdmin();
        const admin = await createAdmin();
        await pool.query(`UPDATE users SET role = 'AUTHOR' WHERE id = $1`, [admin.userId]);
        const stale = await request(app).get('/api/v1/admin/users').set(bearer(admin.token));
        expect(stale.status).toBe(403);

        const lockedAdmin = await createAdmin();
        await pool.query(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [lockedAdmin.userId]);
        const lockedRes = await request(app)
            .get('/api/v1/admin/users')
            .set(bearer(lockedAdmin.token));
        expect(lockedRes.status).toBe(423);
        expect(lockedRes.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('trả thống kê dashboard và hành vi quản trị trong ngày', async () => {
        const admin = await createAdmin();
        const email = uniqueEmail('Dashboard');
        const created = await request(app)
            .post('/api/v1/admin/users')
            .set(bearer(admin.token))
            .send({ email, password: PASSWORD, displayName: 'Dashboard User' });
        expect(created.status).toBe(201);

        const storageUsedBytes = 123_456;
        await pool.query(`UPDATE users SET storage_used_bytes = $2 WHERE id = $1`, [
            created.body.data.id,
            storageUsedBytes,
        ]);
        const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const book = await pool.query<{ id: string }>(
            `INSERT INTO books (owner_id, title, status, slug, first_published_at)
             VALUES ($1, 'Sách dashboard', 'PUBLISHED', $2, now()) RETURNING id`,
            [created.body.data.id, `dashboard-${marker}`],
        );
        const bookId = (book.rows[0] as { id: string }).id;
        await Promise.all([
            pool.query(
                `INSERT INTO jobs
                    (type, status, ref_type, ref_id, error, created_at, finished_at)
                 VALUES ('PUBLISH_BOOK', 'FAILED', 'BOOK', $1, $2::jsonb, now(), now())`,
                [bookId, JSON.stringify({ code: 'JOB_FAILED', message: 'Test dashboard' })],
            ),
            pool.query(
                `INSERT INTO reports (book_id, reason, reporter_fingerprint)
                 VALUES ($1, 'OTHER', $2)`,
                [bookId, `dashboard-${marker}`],
            ),
        ]);

        const response = await request(app).get('/api/v1/admin/dashboard').set(bearer(admin.token));
        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
            users: expect.any(Number),
            publishedBooks: expect.any(Number),
            storageUsedBytes: expect.any(Number),
            failedJobs24h: expect.any(Number),
            openReports: expect.any(Number),
        });
        expect(response.body.data.users).toBeGreaterThanOrEqual(2);
        expect(response.body.data.publishedBooks).toBeGreaterThanOrEqual(1);
        expect(response.body.data.storageUsedBytes).toBeGreaterThanOrEqual(storageUsedBytes);
        expect(response.body.data.failedJobs24h).toBeGreaterThanOrEqual(1);
        expect(response.body.data.openReports).toBeGreaterThanOrEqual(1);
        expect(response.body.data.publishedPerDay).toHaveLength(7);
        expect(response.body.data.publishedPerDay.at(-1).count).toBeGreaterThanOrEqual(1);
        expect(response.body.data.auditActionsToday).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ action: 'CREATE_USER', count: expect.any(Number) }),
            ]),
        );
    });

    it('tạo người dùng đăng nhập được, ghi audit và chặn email trùng', async () => {
        const admin = await createAdmin();
        const email = uniqueEmail('Created');
        const created = await request(app)
            .post('/api/v1/admin/users')
            .set(bearer(admin.token))
            .send({
                email,
                password: PASSWORD,
                displayName: 'Người được tạo',
            });
        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({
            email,
            displayName: 'Người được tạo',
            role: 'AUTHOR',
            status: 'ACTIVE',
            emailVerified: false,
            storage: { usedBytes: 0, quotaBytes: 500 * 1024 * 1024 },
            bookCount: 0,
        });

        const accessToken = await login(email);
        expect(accessToken).toBeTruthy();

        const audit = await pool.query<{
            action: string;
            target_id: string;
            detail: Record<string, unknown>;
        }>(
            `SELECT action, target_id, detail FROM audit_logs
             WHERE actor_id = $1 AND action = 'CREATE_USER' ORDER BY id DESC LIMIT 1`,
            [admin.userId],
        );
        expect(audit.rows[0]).toEqual({
            action: 'CREATE_USER',
            target_id: created.body.data.id,
            detail: {
                email,
                displayName: 'Người được tạo',
                role: 'AUTHOR',
                status: 'ACTIVE',
                storageQuotaBytes: 500 * 1024 * 1024,
            },
        });

        const duplicate = await request(app)
            .post('/api/v1/admin/users')
            .set(bearer(admin.token))
            .send({ email, password: PASSWORD, displayName: 'Trùng email' });
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('sắp xếp theo các trường cho phép', async () => {
        const admin = await createAdmin();
        const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        for (const displayName of [`Zulu ${marker}`, `Alpha ${marker}`]) {
            const response = await request(app)
                .post('/api/v1/admin/users')
                .set(bearer(admin.token))
                .send({
                    email: uniqueEmail(marker),
                    password: PASSWORD,
                    displayName,
                });
            expect(response.status).toBe(201);
        }

        const ascending = await request(app)
            .get(`/api/v1/admin/users?q=${marker}&sort=displayName`)
            .set(bearer(admin.token));
        expect(ascending.status).toBe(200);
        expect(
            ascending.body.data.map((user: { displayName: string }) => user.displayName),
        ).toEqual([`Alpha ${marker}`, `Zulu ${marker}`]);
        expect(ascending.body.data[0].updatedAt).toBeTruthy();

        for (const sort of ['email', '-createdAt', 'updatedAt', '-storageUsedBytes']) {
            const response = await request(app)
                .get(`/api/v1/admin/users?q=${marker}&sort=${sort}`)
                .set(bearer(admin.token));
            expect(response.status).toBe(200);
        }
    });

    it('tìm người dùng và trả chi tiết kèm sách có coverUrl', async () => {
        const admin = await createAdmin();
        const author = await register('Nguoi Viet');
        const coverAssetId = await createReadyAsset(author.userId, 'Ảnh bìa sách');
        await pool.query(
            `INSERT INTO books (owner_id, title, cover_asset_id, visibility) VALUES ($1, 'Sách kiểm thử', $2, 'PUBLIC')`,
            [author.userId, coverAssetId],
        );

        const list = await request(app)
            .get(`/api/v1/admin/users?q=${encodeURIComponent(author.email)}`)
            .set(bearer(admin.token));
        expect(list.status).toBe(200);
        expect(list.body.meta.total).toBe(1);
        expect(list.body.data[0]).toMatchObject({
            id: author.userId,
            email: author.email,
            bookCount: 1,
        });

        const detail = await request(app)
            .get(`/api/v1/admin/users/${author.userId}`)
            .set(bearer(admin.token));
        expect(detail.status).toBe(200);
        expect(detail.body.data.books).toHaveLength(1);
        expect(detail.body.data.books[0].title).toBe('Sách kiểm thử');
        expect(detail.body.data.books[0].coverUrl).toContain('https://example.com/assets/');
    });

    it('khóa và mở khóa trong transaction, kèm session, sách, thông báo và audit', async () => {
        const admin = await createAdmin();
        const author = await register('Target');
        await pool.query(
            `INSERT INTO books (owner_id, title, visibility) VALUES ($1, 'Sách công khai', 'PUBLIC')`,
            [author.userId],
        );

        const locked = await request(app)
            .patch(`/api/v1/admin/users/${author.userId}`)
            .set(bearer(admin.token))
            .send({ status: 'LOCKED', reason: 'Vi phạm điều khoản' });
        expect(locked.status).toBe(200);
        expect(locked.body.data.user.status).toBe('LOCKED');

        const lockedState = await pool.query<{
            status: string;
            visibility: string;
            visibility_before_lock: string;
            active_sessions: number;
        }>(
            `SELECT u.status, b.visibility, b.visibility_before_lock,
                (SELECT count(*)::int FROM auth_sessions s
                 WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS active_sessions
             FROM users u JOIN books b ON b.owner_id = u.id WHERE u.id = $1`,
            [author.userId],
        );
        expect(lockedState.rows[0]).toMatchObject({
            status: 'LOCKED',
            visibility: 'PRIVATE',
            visibility_before_lock: 'PUBLIC',
            active_sessions: 0,
        });

        const unlocked = await request(app)
            .patch(`/api/v1/admin/users/${author.userId}`)
            .set(bearer(admin.token))
            .send({ status: 'ACTIVE', reason: 'Đã xử lý' });
        expect(unlocked.status).toBe(200);

        const restored = await pool.query<{
            visibility: string;
            visibility_before_lock: string | null;
        }>(`SELECT visibility, visibility_before_lock FROM books WHERE owner_id = $1`, [
            author.userId,
        ]);
        expect(restored.rows[0]).toEqual({
            visibility: 'PUBLIC',
            visibility_before_lock: null,
        });

        const effects = await pool.query<{ notifications: number }>(
            `SELECT
                (SELECT count(*)::int FROM notifications WHERE user_id = $1) AS notifications`,
            [author.userId],
        );
        expect(effects.rows[0]).toEqual({ notifications: 2 });
        const audits = await pool.query<{ action: string; detail: Record<string, unknown> }>(
            `SELECT action, detail FROM audit_logs
             WHERE actor_id = $1 AND target_id = $2 ORDER BY id`,
            [admin.userId, author.userId],
        );
        expect(audits.rows).toEqual([
            {
                action: 'LOCK_USER',
                detail: { from: 'ACTIVE', to: 'LOCKED', reason: 'Vi phạm điều khoản' },
            },
            {
                action: 'UNLOCK_USER',
                detail: { from: 'LOCKED', to: 'ACTIVE', reason: 'Đã xử lý' },
            },
        ]);
    });

    it('hạ quyền có hiệu lực ngay và thay đổi quota được ghi audit', async () => {
        const actor = await createAdmin();
        const target = await createAdmin();
        const quota = 750 * 1024 * 1024;

        const response = await request(app)
            .patch(`/api/v1/admin/users/${target.userId}`)
            .set(bearer(actor.token))
            .send({ role: 'AUTHOR', storageQuotaBytes: quota, reason: 'Điều chỉnh quyền' });
        expect(response.status).toBe(200);
        expect(response.body.data.user).toMatchObject({
            role: 'AUTHOR',
            storageQuotaBytes: quota,
        });

        const state = await pool.query<{ active_sessions: number }>(
            `SELECT
                (SELECT count(*)::int FROM auth_sessions
                 WHERE user_id = $1 AND revoked_at IS NULL) AS active_sessions`,
            [target.userId],
        );
        expect(state.rows[0]).toEqual({ active_sessions: 0 });
        const audits = await pool.query<{ action: string; detail: Record<string, unknown> }>(
            `SELECT action, detail FROM audit_logs
             WHERE actor_id = $1 AND target_id = $2 ORDER BY id`,
            [actor.userId, target.userId],
        );
        expect(audits.rows).toEqual([
            {
                action: 'CHANGE_ROLE',
                detail: { from: 'ADMIN', to: 'AUTHOR', reason: 'Điều chỉnh quyền' },
            },
            {
                action: 'SET_QUOTA',
                detail: {
                    from: 500 * 1024 * 1024,
                    to: quota,
                    reason: 'Điều chỉnh quyền',
                },
            },
        ]);
    });

    it('không cập nhật hoặc ghi audit khi giá trị không đổi', async () => {
        const admin = await createAdmin();
        const author = await register('NoChange');
        const before = await pool.query<{ updated_at: Date }>(
            `SELECT updated_at FROM users WHERE id = $1`,
            [author.userId],
        );

        const response = await request(app)
            .patch(`/api/v1/admin/users/${author.userId}`)
            .set(bearer(admin.token))
            .send({ status: 'ACTIVE', reason: 'Không đổi' });
        expect(response.status).toBe(200);

        const after = await pool.query<{ updated_at: Date; audits: number }>(
            `SELECT updated_at,
                (SELECT count(*)::int FROM audit_logs
                 WHERE actor_id = $2 AND target_id = $1) AS audits
             FROM users WHERE id = $1`,
            [author.userId, admin.userId],
        );
        expect(after.rows[0]).toEqual({ updated_at: before.rows[0]?.updated_at, audits: 0 });
    });

    it('không cho admin tự khóa hoặc tự hạ quyền', async () => {
        const admin = await createAdmin();
        const response = await request(app)
            .patch(`/api/v1/admin/users/${admin.userId}`)
            .set(bearer(admin.token))
            .send({ role: 'AUTHOR', reason: 'Không hợp lệ' });
        expect(response.status).toBe(422);
        expect(response.body.error.code).toBe('SELF_ACTION');
    });

    it('chặn khóa hoặc hạ quyền admin cuối cùng (LAST_ADMIN)', async () => {
        const actorAdmin = await createAdmin();
        const targetAdmin = await createAdmin();

        await pool.query(`UPDATE users SET role = 'AUTHOR' WHERE id <> $1 AND role = 'ADMIN'`, [
            targetAdmin.userId,
        ]);

        await expect(
            adminService.updateUser(
                { userId: actorAdmin.userId, role: 'ADMIN', sessionId: actorAdmin.token },
                targetAdmin.userId,
                { role: 'AUTHOR', reason: 'Hạ quyền admin cuối cùng' },
            ),
        ).rejects.toMatchObject({ code: 'LAST_ADMIN' });

        await expect(
            adminService.updateUser(
                { userId: actorAdmin.userId, role: 'ADMIN', sessionId: actorAdmin.token },
                targetAdmin.userId,
                { status: 'LOCKED', reason: 'Khóa admin cuối cùng' },
            ),
        ).rejects.toMatchObject({ code: 'LAST_ADMIN' });

        await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [actorAdmin.userId]);
    });
});

suite('kiểm duyệt của admin', () => {
    it('trả hàng chờ gộp theo sách, danh sách chủ động và chi tiết trang/báo cáo', async () => {
        const admin = await createAdmin();
        const author = await register('ModerationAuthor');
        const { bookId, title } = await createReportedBook(author.userId);

        const queue = await request(app).get('/api/v1/admin/moderation').set(bearer(admin.token));
        expect(queue.status).toBe(200);
        expect(queue.body.data).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    book: expect.objectContaining({ id: bookId, title }),
                    reportCount: 2,
                    reasons: expect.arrayContaining(['COPYRIGHT', 'OTHER']),
                }),
            ]),
        );

        const books = await request(app)
            .get(`/api/v1/admin/books?q=${encodeURIComponent(title)}`)
            .set(bearer(admin.token));
        expect(books.status).toBe(200);
        expect(books.body.meta.total).toBe(1);
        expect(books.body.data[0]).toMatchObject({
            id: bookId,
            visibility: 'PUBLIC',
            reportCount: 2,
            pageCount: 1,
            author: { id: author.userId },
        });

        const detail = await request(app)
            .get(`/api/v1/admin/books/${bookId}`)
            .set(bearer(admin.token));
        expect(detail.status).toBe(200);
        expect(detail.body.data.book).toMatchObject({
            id: bookId,
            description: 'Mô tả kiểm duyệt',
            pages: [
                expect.objectContaining({
                    orderIndex: 0,
                    title: 'Trang đầu',
                    markerMode: 'NONE',
                    objectCount: 0,
                }),
            ],
        });
        expect(detail.body.data.reports).toHaveLength(2);
    });

    it('gỡ và khôi phục sách cùng báo cáo, thông báo và audit trong transaction', async () => {
        const admin = await createAdmin();
        const author = await register('TakedownAuthor');
        const { bookId } = await createReportedBook(author.userId);

        const takenDown = await request(app)
            .post(`/api/v1/admin/books/${bookId}/takedown`)
            .set(bearer(admin.token))
            .send({ reason: 'Vi phạm bản quyền' });
        expect(takenDown.status).toBe(200);
        expect(takenDown.body.data).toEqual({
            book: { id: bookId, visibility: 'PRIVATE', takenDown: true },
            resolvedReports: 2,
        });

        const repeated = await request(app)
            .post(`/api/v1/admin/books/${bookId}/takedown`)
            .set(bearer(admin.token))
            .send({ reason: 'Không ghi đè' });
        expect(repeated.body.data.resolvedReports).toBe(0);

        const removed = await pool.query<{
            visibility: string;
            visibility_before_lock: string;
            taken_down_reason: string;
            actioned_reports: number;
            notifications: number;
            audits: number;
        }>(
            `SELECT b.visibility, b.visibility_before_lock, b.taken_down_reason,
                (SELECT count(*)::int FROM reports
                 WHERE book_id = b.id AND status = 'ACTIONED') AS actioned_reports,
                (SELECT count(*)::int FROM notifications
                 WHERE user_id = b.owner_id AND type = 'BOOK_TAKEN_DOWN') AS notifications,
                (SELECT count(*)::int FROM audit_logs
                 WHERE target_id = b.id AND action = 'TAKE_DOWN_BOOK') AS audits
             FROM books b WHERE b.id = $1`,
            [bookId],
        );
        expect(removed.rows[0]).toEqual({
            visibility: 'PRIVATE',
            visibility_before_lock: 'PUBLIC',
            taken_down_reason: 'Vi phạm bản quyền',
            actioned_reports: 2,
            notifications: 1,
            audits: 1,
        });

        const reinstated = await request(app)
            .post(`/api/v1/admin/books/${bookId}/reinstate`)
            .set(bearer(admin.token))
            .send({ note: 'Đã xác minh quyền sử dụng' });
        expect(reinstated.status).toBe(200);
        expect(reinstated.body.data.book).toMatchObject({
            id: bookId,
            visibility: 'PUBLIC',
            takenDown: false,
        });

        const restored = await pool.query<{
            visibility: string;
            visibility_before_lock: string | null;
            taken_down_at: Date | null;
            taken_down_reason: string | null;
            notifications: number;
            audits: number;
        }>(
            `SELECT b.visibility, b.visibility_before_lock, b.taken_down_at, b.taken_down_reason,
                (SELECT count(*)::int FROM notifications
                 WHERE user_id = b.owner_id AND type = 'BOOK_REINSTATED') AS notifications,
                (SELECT count(*)::int FROM audit_logs
                 WHERE target_id = b.id AND action = 'REINSTATE_BOOK') AS audits
             FROM books b WHERE b.id = $1`,
            [bookId],
        );
        expect(restored.rows[0]).toEqual({
            visibility: 'PUBLIC',
            visibility_before_lock: null,
            taken_down_at: null,
            taken_down_reason: null,
            notifications: 1,
            audits: 1,
        });
    });

    it('khôi phục sách vẫn giữ PRIVATE khi tác giả đang bị khóa', async () => {
        const admin = await createAdmin();
        const author = await register('LockedBookAuthor');
        const { bookId } = await createReportedBook(author.userId, []);
        await request(app)
            .post(`/api/v1/admin/books/${bookId}/takedown`)
            .set(bearer(admin.token))
            .send({ reason: 'Kiểm tra' });
        await pool.query(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [author.userId]);

        const response = await request(app)
            .post(`/api/v1/admin/books/${bookId}/reinstate`)
            .set(bearer(admin.token))
            .send({});
        expect(response.status).toBe(200);
        expect(response.body.data.book.visibility).toBe('PRIVATE');
        const book = await pool.query<{ visibility_before_lock: string }>(
            `SELECT visibility_before_lock FROM books WHERE id = $1`,
            [bookId],
        );
        expect(book.rows[0]?.visibility_before_lock).toBe('PUBLIC');
    });

    it('bỏ qua toàn bộ báo cáo OPEN và chỉ ghi audit khi có thay đổi', async () => {
        const admin = await createAdmin();
        const author = await register('DismissAuthor');
        const { bookId } = await createReportedBook(author.userId, ['OTHER']);

        const dismissed = await request(app)
            .post(`/api/v1/admin/books/${bookId}/reports/dismiss`)
            .set(bearer(admin.token))
            .send({ note: 'Không vi phạm' });
        expect(dismissed.status).toBe(200);
        expect(dismissed.body.data.dismissedReports).toBe(1);

        const repeated = await request(app)
            .post(`/api/v1/admin/books/${bookId}/reports/dismiss`)
            .set(bearer(admin.token))
            .send({ note: 'Không còn báo cáo' });
        expect(repeated.body.data.dismissedReports).toBe(0);

        const state = await pool.query<{
            status: string;
            handled_by: string;
            resolution_note: string;
            taken_down_at: Date | null;
            audit_count: number;
            target_type: string;
        }>(
            `SELECT r.status, r.handled_by, r.resolution_note, b.taken_down_at,
                (SELECT count(*)::int FROM audit_logs
                 WHERE target_id = b.id AND action = 'DISMISS_REPORT') AS audit_count,
                (SELECT target_type FROM audit_logs
                 WHERE target_id = b.id AND action = 'DISMISS_REPORT' LIMIT 1) AS target_type
             FROM reports r JOIN books b ON b.id = r.book_id
             WHERE r.book_id = $1`,
            [bookId],
        );
        expect(state.rows[0]).toEqual({
            status: 'DISMISSED',
            handled_by: admin.userId,
            resolution_note: 'Không vi phạm',
            taken_down_at: null,
            audit_count: 1,
            target_type: 'BOOK',
        });
    });
});

suite('thư viện tài nguyên chung của admin', () => {
    it('adds and lists legacy audio without zero dimensions', async () => {
        const admin = await createAdmin();
        const author = await register('LegacyAudioAuthor');
        const assetId = await createReadyAsset(author.userId);
        await pool.query(
            `UPDATE assets SET type = 'AUDIO', format = 'wav', resource_type = 'video',
            meta = $2::jsonb WHERE id = $1`,
            [assetId, JSON.stringify({ width: 0, height: 0, durationSec: 0.5 })],
        );
        const created = await request(app)
            .post('/api/v1/admin/library/assets')
            .set(bearer(admin.token))
            .send({ assetId, name: 'Legacy audio', license: 'CC0', authorName: 'Tác giả' });
        expect(created.status).toBe(201);
        expect(created.body.data.meta).toEqual({ durationSec: 0.5 });
        const list = await request(app)
            .get('/api/v1/admin/library/assets?type=AUDIO')
            .set(bearer(admin.token));
        expect(list.status).toBe(200);
        expect(list.body.data.find((a: { id: string }) => a.id === assetId)?.meta).toEqual({
            durationSec: 0.5,
        });
    });

    it('dựng URL giao tài nguyên từ Cloudinary public id', async () => {
        const admin = await createAdmin();
        const author = await register('LibraryUrlAuthor');
        const assetId = await createReadyAsset(author.userId);
        await pool.query(
            `UPDATE assets SET original_public_id = 'bookaria/library/example', thumbnail_url = NULL
             WHERE id = $1`,
            [assetId],
        );
        const previousCloudinaryUrl = env.CLOUDINARY_URL;
        env.CLOUDINARY_URL = 'cloudinary://key:secret@test-cloud';
        try {
            const response = await request(app)
                .post('/api/v1/admin/library/assets')
                .set(bearer(admin.token))
                .send({
                    assetId,
                    name: 'Asset Cloudinary',
                    license: 'CC0',
                    authorName: 'Tác giả',
                });
            expect(response.status).toBe(201);
            expect(response.body.data.url).toBe(
                'https://res.cloudinary.com/test-cloud/image/upload/bookaria/library/example.jpg',
            );
        } finally {
            env.CLOUDINARY_URL = previousCloudinaryUrl;
        }
    });

    it('liệt kê, thêm, sửa, xoá mềm asset và ghi audit', async () => {
        const admin = await createAdmin();
        const author = await register('LibraryAssetAuthor');
        const assetId = await createReadyAsset(author.userId, 'Cây xanh');
        const category = await request(app)
            .post('/api/v1/admin/asset-categories')
            .set(bearer(admin.token))
            .send({ name: 'Thiên nhiên' });
        const categoryId = category.body.data.id as string;

        const invalid = await request(app)
            .post('/api/v1/admin/library/assets')
            .set(bearer(admin.token))
            .send({ assetId, name: 'Cây thư viện', authorName: 'Tác giả gốc' });
        expect(invalid.status).toBe(400);

        const created = await request(app)
            .post('/api/v1/admin/library/assets')
            .set(bearer(admin.token))
            .send({
                assetId,
                name: 'Cây thư viện',
                categoryId,
                license: 'CC-BY-4.0',
                authorName: 'Tác giả gốc',
                sourceUrl: 'https://example.com/source',
                tags: ['Nature', 'nature', 'Tree'],
            });
        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({
            id: assetId,
            scope: 'library',
            categoryId,
            license: 'CC-BY-4.0',
            authorName: 'Tác giả gốc',
            tags: ['nature', 'tree'],
        });

        const listed = await request(app)
            .get(
                `/api/v1/admin/library/assets?type=IMAGE&categoryId=${categoryId}&q=${encodeURIComponent('Cây')}`,
            )
            .set(bearer(admin.token));
        expect(listed.status).toBe(200);
        expect(listed.body.meta.total).toBe(1);
        expect(listed.body.data[0].id).toBe(assetId);

        const updated = await request(app)
            .patch(`/api/v1/admin/library/assets/${assetId}`)
            .set(bearer(admin.token))
            .send({ name: 'Cây đã sửa', categoryId: null, license: 'CC0' });
        expect(updated.status).toBe(200);
        expect(updated.body.data).toMatchObject({
            id: assetId,
            name: 'Cây đã sửa',
            categoryId: null,
            license: 'CC0',
        });

        const removed = await request(app)
            .delete(`/api/v1/admin/library/assets/${assetId}`)
            .set(bearer(admin.token));
        expect(removed.status).toBe(204);

        const state = await pool.query<{
            owner_id: string | null;
            deleted_at: Date | null;
            audits: number;
        }>(
            `SELECT owner_id, deleted_at,
                (SELECT count(*)::int FROM audit_logs
                 WHERE target_id = assets.id
                   AND action IN ('CREATE_LIBRARY_ASSET', 'UPDATE_LIBRARY_ASSET', 'DELETE_ASSET')) AS audits
             FROM assets WHERE id = $1`,
            [assetId],
        );
        expect(state.rows[0]).toMatchObject({ owner_id: null, audits: 3 });
        expect(state.rows[0]?.deleted_at).toBeInstanceOf(Date);
    });

    it('không xoá asset đang được book hoặc page sử dụng', async () => {
        const admin = await createAdmin();
        const author = await register('UsedLibraryAssetAuthor');
        const assetId = await createReadyAsset(author.userId);
        await request(app).post('/api/v1/admin/library/assets').set(bearer(admin.token)).send({
            assetId,
            name: 'Asset đang dùng',
            license: 'CC-BY',
            authorName: 'Tác giả',
        });
        const book = await pool.query<{ id: string }>(
            `INSERT INTO books (owner_id, title, cover_asset_id)
             VALUES ($1, 'Sách dùng asset', $2) RETURNING id`,
            [author.userId, assetId],
        );
        const bookId = (book.rows[0] as { id: string }).id;
        const page = await pool.query<{ id: string }>(
            `INSERT INTO pages (book_id, order_index, image_asset_id, marker_mode)
             VALUES ($1, 0, $2, 'NONE') RETURNING id`,
            [bookId, assetId],
        );
        await pool.query(`INSERT INTO page_assets (page_id, asset_id) VALUES ($1, $2)`, [
            (page.rows[0] as { id: string }).id,
            assetId,
        ]);

        const response = await request(app)
            .delete(`/api/v1/admin/library/assets/${assetId}`)
            .set(bearer(admin.token));
        expect(response.status).toBe(409);
        expect(response.body.error).toMatchObject({
            code: 'ASSET_IN_USE',
            details: { covers: 1, pageImages: 1, pageAssets: 1 },
        });
        const asset = await pool.query<{ deleted_at: Date | null }>(
            `SELECT deleted_at FROM assets WHERE id = $1`,
            [assetId],
        );
        expect(asset.rows[0]?.deleted_at).toBeNull();
    });

    it('chặn category còn nội dung và cây category vòng lặp', async () => {
        const admin = await createAdmin();
        const author = await register('LibraryCategoryAuthor');
        const parent = await request(app)
            .post('/api/v1/admin/asset-categories')
            .set(bearer(admin.token))
            .send({ name: 'Danh mục cha' });
        const parentId = parent.body.data.id as string;
        const child = await request(app)
            .post('/api/v1/admin/asset-categories')
            .set(bearer(admin.token))
            .send({ name: 'Danh mục con', parentId });
        const childId = child.body.data.id as string;

        const updated = await request(app)
            .patch(`/api/v1/admin/asset-categories/${childId}`)
            .set(bearer(admin.token))
            .send({ name: 'Danh mục con mới', sortOrder: 5 });
        expect(updated.status).toBe(200);
        expect(updated.body.data).toMatchObject({ name: 'Danh mục con mới', sortOrder: 5 });

        const cycle = await request(app)
            .patch(`/api/v1/admin/asset-categories/${parentId}`)
            .set(bearer(admin.token))
            .send({ parentId: childId });
        expect(cycle.status).toBe(422);
        expect(cycle.body.error.code).toBe('CATEGORY_CYCLE');

        const parentWithChild = await request(app)
            .delete(`/api/v1/admin/asset-categories/${parentId}`)
            .set(bearer(admin.token));
        expect(parentWithChild.status).toBe(409);
        expect(parentWithChild.body.error.code).toBe('CATEGORY_NOT_EMPTY');

        expect(
            (
                await request(app)
                    .delete(`/api/v1/admin/asset-categories/${childId}`)
                    .set(bearer(admin.token))
            ).status,
        ).toBe(204);

        const assetId = await createReadyAsset(author.userId);
        await request(app).post('/api/v1/admin/library/assets').set(bearer(admin.token)).send({
            assetId,
            name: 'Asset trong category',
            categoryId: parentId,
            license: 'CC0',
            authorName: 'Tác giả',
        });
        const parentWithAsset = await request(app)
            .delete(`/api/v1/admin/asset-categories/${parentId}`)
            .set(bearer(admin.token));
        expect(parentWithAsset.status).toBe(409);

        await request(app)
            .delete(`/api/v1/admin/library/assets/${assetId}`)
            .set(bearer(admin.token));
        expect(
            (
                await request(app)
                    .delete(`/api/v1/admin/asset-categories/${parentId}`)
                    .set(bearer(admin.token))
            ).status,
        ).toBe(204);

        const audits = await pool.query<{ operation: string }>(
            `SELECT detail->>'operation' AS operation FROM audit_logs
             WHERE target_type = 'CATEGORY' AND target_id = ANY($1::uuid[])
             ORDER BY id`,
            [[parentId, childId]],
        );
        expect(audits.rows.map((row) => row.operation)).toEqual([
            'CREATE',
            'CREATE',
            'UPDATE',
            'DELETE',
            'DELETE',
        ]);
    });
});

suite('bộ marker Bookaria của admin', () => {
    it('liệt kê, thêm, bật/tắt marker; chặn number hoặc seed trùng và ghi audit', async () => {
        const admin = await createAdmin();
        const markerNumber = 1_000_000 + (Date.now() % 1_000_000);
        const seed = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
        const previousCloudinaryUrl = env.CLOUDINARY_URL;
        env.CLOUDINARY_URL = 'cloudinary://key:secret@test-cloud';
        let markerId: string;
        try {
            const created = await request(app)
                .post('/api/v1/admin/bookaria-markers')
                .set(bearer(admin.token))
                .send({
                    number: markerNumber,
                    imagePublicId: `bookaria/markers/${markerNumber}`,
                    mindPublicId: `bookaria/markers/${markerNumber}.mind`,
                    seed,
                    markerScore: 5,
                });
            expect(created.status).toBe(201);
            expect(created.body.data).toMatchObject({
                number: markerNumber,
                imageUrl: `https://res.cloudinary.com/test-cloud/image/upload/bookaria/markers/${markerNumber}`,
                markerScore: 5,
                isActive: true,
            });
            expect(created.body.data.validatedAt).toBeTruthy();
            markerId = created.body.data.id as string;

            const listed = await request(app)
                .get('/api/v1/admin/bookaria-markers?page=1&limit=20')
                .set(bearer(admin.token));
            expect(listed.status).toBe(200);
            expect(listed.body.data).toEqual(
                expect.arrayContaining([expect.objectContaining({ id: markerId })]),
            );

            const duplicateNumber = await request(app)
                .post('/api/v1/admin/bookaria-markers')
                .set(bearer(admin.token))
                .send({
                    number: markerNumber,
                    imagePublicId: 'bookaria/markers/duplicate-number',
                    mindPublicId: 'bookaria/markers/duplicate-number.mind',
                    seed: seed + 1,
                });
            expect(duplicateNumber.body.error.code).toBe('MARKER_DUPLICATE');
            expect(duplicateNumber.status).toBe(409);

            const duplicateSeed = await request(app)
                .post('/api/v1/admin/bookaria-markers')
                .set(bearer(admin.token))
                .send({
                    number: markerNumber + 1,
                    imagePublicId: 'bookaria/markers/duplicate-seed',
                    mindPublicId: 'bookaria/markers/duplicate-seed.mind',
                    seed,
                });
            expect(duplicateSeed.body.error.code).toBe('MARKER_DUPLICATE');
            expect(duplicateSeed.status).toBe(409);

            const disabled = await request(app)
                .patch(`/api/v1/admin/bookaria-markers/${markerId}`)
                .set(bearer(admin.token))
                .send({ isActive: false });
            expect(disabled.status).toBe(200);
            expect(disabled.body.data.isActive).toBe(false);

            const enabled = await request(app)
                .patch(`/api/v1/admin/bookaria-markers/${markerId}`)
                .set(bearer(admin.token))
                .send({ isActive: true });
            expect(enabled.status).toBe(200);
            expect(enabled.body.data.isActive).toBe(true);
        } finally {
            env.CLOUDINARY_URL = previousCloudinaryUrl;
        }

        const audits = await pool.query<{ operation: string }>(
            `SELECT detail->>'operation' AS operation FROM audit_logs
             WHERE target_type = 'MARKER' AND target_id = $1 ORDER BY id`,
            [markerId as string],
        );
        expect(audits.rows.map((row) => row.operation)).toEqual([
            'CREATE',
            'SET_ACTIVE',
            'SET_ACTIVE',
        ]);
    });

    it('không cho page mới nhận marker đang tắt', async () => {
        const admin = await createAdmin();
        const author = await register('InactiveMarkerAuthor');
        const markerNumber = 2_000_000 + (Date.now() % 1_000_000);
        const marker = await request(app)
            .post('/api/v1/admin/bookaria-markers')
            .set(bearer(admin.token))
            .send({
                number: markerNumber,
                imagePublicId: `https://example.com/markers/${markerNumber}.png`,
                mindPublicId: `bookaria/markers/${markerNumber}.mind`,
                seed: Date.now() * 1_000 + Math.floor(Math.random() * 1_000),
            });
        expect(marker.status).toBe(201);
        const markerId = marker.body.data.id as string;
        await request(app)
            .patch(`/api/v1/admin/bookaria-markers/${markerId}`)
            .set(bearer(admin.token))
            .send({ isActive: false });

        const assetId = await createReadyAsset(author.userId);
        const book = await pool.query<{ id: string }>(
            `INSERT INTO books (owner_id, title) VALUES ($1, 'Marker bị tắt') RETURNING id`,
            [author.userId],
        );
        const bookId = (book.rows[0] as { id: string }).id;
        await expect(
            pool.query(
                `INSERT INTO pages (book_id, order_index, image_asset_id, marker_mode, bookaria_marker_id)
                 VALUES ($1, 0, $2, 'BOOKARIA_MARKER', $3)`,
                [bookId, assetId, markerId],
            ),
        ).rejects.toMatchObject({ code: '23514' });

        await request(app)
            .patch(`/api/v1/admin/bookaria-markers/${markerId}`)
            .set(bearer(admin.token))
            .send({ isActive: true });
        await expect(
            pool.query(
                `INSERT INTO pages (book_id, order_index, image_asset_id, marker_mode, bookaria_marker_id)
                 VALUES ($1, 0, $2, 'BOOKARIA_MARKER', $3)`,
                [bookId, assetId, markerId],
            ),
        ).resolves.toBeDefined();
    });
});

suite('jobs và audit của admin', () => {
    it('lọc jobs, chỉ retry job FAILED, tránh job mở trùng và ghi audit để tra cứu', async () => {
        const admin = await createAdmin();
        const author = await register('JobAuthor');
        const { bookId } = await createReportedBook(author.userId, []);
        const failed = await pool.query<{ id: string }>(
            `INSERT INTO jobs
                (type, status, ref_type, ref_id, result, progress, attempts, error, created_by,
                 started_at, finished_at)
             VALUES
                ('PUBLISH_BOOK', 'FAILED', 'BOOK', $1, '{"partial":true}'::jsonb, 60, 2,
                 $2::jsonb, $3, now(), now())
             RETURNING id`,
            [
                bookId,
                JSON.stringify({ code: 'JOB_FAILED', message: 'Không thể xuất bản' }),
                author.userId,
            ],
        );
        const failedJobId = (failed.rows[0] as { id: string }).id;

        const listed = await request(app)
            .get('/api/v1/admin/jobs?status=FAILED&type=PUBLISH_BOOK')
            .set(bearer(admin.token));
        expect(listed.status).toBe(200);
        expect(listed.body.data).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: failedJobId,
                    status: 'FAILED',
                    error: { code: 'JOB_FAILED', message: 'Không thể xuất bản' },
                    attempts: 2,
                    createdBy: { id: author.userId, displayName: 'JobAuthor' },
                }),
            ]),
        );

        const retried = await request(app)
            .post(`/api/v1/admin/jobs/${failedJobId}/retry`)
            .set(bearer(admin.token));
        expect(retried.status).toBe(202);
        const retryJobId = retried.body.data.jobId as string;
        expect(retryJobId).not.toBe(failedJobId);
        expect(
            (await pool.query('SELECT status,attempts FROM jobs WHERE id=$1', [failedJobId]))
                .rows[0],
        ).toEqual({ status: 'FAILED', attempts: 2 });

        const reset = await pool.query<{
            status: string;
            progress: number;
            attempts: number;
            result: Record<string, unknown> | null;
            error: string | null;
            started_at: Date | null;
            finished_at: Date | null;
        }>(
            `SELECT status, progress, attempts, result, error, started_at, finished_at
             FROM jobs WHERE id = $1`,
            [retryJobId],
        );
        expect(reset.rows[0]).toEqual({
            status: 'QUEUED',
            progress: 0,
            attempts: 0,
            result: null,
            error: null,
            started_at: null,
            finished_at: null,
        });

        const retryOpen = await request(app)
            .post(`/api/v1/admin/jobs/${failedJobId}/retry`)
            .set(bearer(admin.token));
        expect(retryOpen.status).toBe(409);
        expect(retryOpen.body.error.code).toBe('JOB_IN_PROGRESS');

        const anotherFailed = await pool.query<{ id: string }>(
            `INSERT INTO jobs (type, status, ref_type, ref_id, error, created_by)
             VALUES ('PUBLISH_BOOK', 'FAILED', 'BOOK', $1, $2::jsonb, $3) RETURNING id`,
            [bookId, JSON.stringify({ code: 'JOB_FAILED', message: 'Lỗi lần hai' }), author.userId],
        );
        const blocked = await request(app)
            .post(`/api/v1/admin/jobs/${anotherFailed.rows[0]?.id}/retry`)
            .set(bearer(admin.token));
        expect(blocked.status).toBe(409);
        expect(blocked.body.error.code).toBe('JOB_IN_PROGRESS');

        const audit = await request(app)
            .get(
                `/api/v1/admin/audit-logs?action=RETRY_JOB&actorId=${admin.userId}&targetType=JOB&targetId=${failedJobId}`,
            )
            .set(bearer(admin.token));
        expect(audit.status).toBe(200);
        expect(audit.body.data).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    action: 'RETRY_JOB',
                    actor: { id: admin.userId, displayName: 'Admin' },
                    target: { type: 'JOB', id: failedJobId },
                }),
            ]),
        );

        const logId = audit.body.data[0].id;
        const single = await request(app)
            .get(`/api/v1/admin/audit-logs/${logId}`)
            .set(bearer(admin.token));
        expect(single.status).toBe(200);
        expect(single.body.data).toMatchObject({
            id: logId,
            action: 'RETRY_JOB',
            target: { type: 'JOB', id: failedJobId },
        });

        const notFound = await request(app)
            .get('/api/v1/admin/audit-logs/999999999')
            .set(bearer(admin.token));
        expect(notFound.status).toBe(404);
        expect(notFound.body.error.code).toBe('NOT_FOUND');
    });
});
