import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';

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

        const audit = await pool.query<{ action: string; target_id: string }>(
            `SELECT action, target_id FROM audit_logs
             WHERE actor_id = $1 AND action = 'CREATE_USER' ORDER BY id DESC LIMIT 1`,
            [admin.userId],
        );
        expect(audit.rows[0]).toEqual({
            action: 'CREATE_USER',
            target_id: created.body.data.id,
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

    it('tìm người dùng và trả chi tiết kèm sách', async () => {
        const admin = await createAdmin();
        const author = await register('Nguoi Viet');
        await pool.query(
            `INSERT INTO books (owner_id, title, visibility) VALUES ($1, 'Sách kiểm thử', 'PUBLIC')`,
            [author.userId],
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

        const effects = await pool.query<{ notifications: number; audits: number }>(
            `SELECT
                (SELECT count(*)::int FROM notifications WHERE user_id = $1) AS notifications,
                (SELECT count(*)::int FROM audit_logs WHERE actor_id = $2 AND target_id = $1) AS audits`,
            [author.userId, admin.userId],
        );
        expect(effects.rows[0]).toEqual({ notifications: 2, audits: 2 });
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

        const state = await pool.query<{ active_sessions: number; audits: number }>(
            `SELECT
                (SELECT count(*)::int FROM auth_sessions
                 WHERE user_id = $1 AND revoked_at IS NULL) AS active_sessions,
                (SELECT count(*)::int FROM audit_logs
                 WHERE actor_id = $2 AND target_id = $1) AS audits`,
            [target.userId, actor.userId],
        );
        expect(state.rows[0]).toEqual({ active_sessions: 0, audits: 2 });
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
});
