import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { type Mail, setMailer } from '../../../lib';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;

const PASSWORD = 'Matkhau-123';
const NEW_PASSWORD = 'Matkhau-456-moi';
const app = createApp();
const sent: Mail[] = [];

const uniqueEmail = () =>
    `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;

async function signUp() {
    const email = uniqueEmail();
    const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, displayName: 'An' });
    const token = res.body.data.accessToken as string;
    const userId = res.body.data.user.id as string;
    return { email, token, userId };
}
const login = (email: string, password: string) =>
    request(app).post('/api/v1/auth/login').send({ email, password });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function waitForMail(to: string, match: RegExp): Promise<Mail> {
    for (let i = 0; i < 100; i++) {
        const mail = sent.find((m) => m.to === to && match.test(m.subject));
        if (mail) return mail;
        await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Không thấy thư gửi tới ${to}`);
}

suite('me (tích hợp)', () => {
    beforeAll(() => {
        setMailer({
            async send(mail) {
                sent.push(mail);
            },
        });
    });

    describe('xác thực', () => {
        it('không có token -> 401 UNAUTHENTICATED', async () => {
            const res = await request(app).get('/api/v1/me');
            expect(res.status).toBe(401);
            expect(res.body.error.code).toBe('UNAUTHENTICATED');
        });
    });

    describe('GET/PATCH /me', () => {
        it('trả hồ sơ của chính mình', async () => {
            const { email, token } = await signUp();
            const res = await request(app).get('/api/v1/me').set(bearer(token));
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                email,
                displayName: 'An',
                emailVerified: false,
                role: 'AUTHOR',
            });
            expect(JSON.stringify(res.body)).not.toContain('password');
        });

        it('sửa tên, đơn vị; chuỗi rỗng của organization thành null', async () => {
            const { token } = await signUp();
            const res = await request(app)
                .patch('/api/v1/me')
                .set(bearer(token))
                .send({ displayName: '  Bình  ', organization: 'Nhà xuất bản X', bio: '' });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                displayName: 'Bình',
                organization: 'Nhà xuất bản X',
                bio: null,
            });
        });

        it('body rỗng hoặc sai kiểu -> 400 VALIDATION_ERROR (không phải 500)', async () => {
            const { token } = await signUp();
            for (const body of [{}, { displayName: '' }, { displayName: 'x'.repeat(101) }]) {
                const res = await request(app).patch('/api/v1/me').set(bearer(token)).send(body);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe('VALIDATION_ERROR');
            }
        });

        it('đặt avatarAssetId là một id -> 400 (chưa hỗ trợ), null thì xoá ảnh', async () => {
            const { token } = await signUp();
            const set = await request(app)
                .patch('/api/v1/me')
                .set(bearer(token))
                .send({ avatarAssetId: '3f2b1c4e-5a6d-4e8f-9a0b-1c2d3e4f5a6b' });
            expect(set.status).toBe(400);
            expect(set.body.error.details[0].path).toBe('avatarAssetId');

            const clear = await request(app)
                .patch('/api/v1/me')
                .set(bearer(token))
                .send({ avatarAssetId: null });
            expect(clear.status).toBe(200);
            expect(clear.body.data.avatarUrl).toBeNull();
        });
    });

    describe('PUT /me/password', () => {
        it('đổi thành công: 204, mật khẩu mới dùng được, cũ không, có thư thông báo', async () => {
            const { email, token } = await signUp();
            const res = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(token))
                .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
            expect(res.status).toBe(204);

            expect((await login(email, NEW_PASSWORD)).status).toBe(200);
            expect((await login(email, PASSWORD)).status).toBe(401);
            expect((await waitForMail(email, /mật khẩu/i)).to).toBe(email);
        });

        it('các thiết bị khác bị đăng xuất, phiên hiện tại vẫn dùng được', async () => {
            const { email, token } = await signUp();
            const other = await login(email, PASSWORD);
            const otherToken = other.body.data.accessToken as string;

            const res = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(token))
                .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
            expect(res.status).toBe(204);

            // Phiên đang dùng vẫn sống.
            const again = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(token))
                .send({ currentPassword: NEW_PASSWORD, newPassword: PASSWORD });
            expect(again.status).toBe(204);

            // Phiên của thiết bị kia đã bị thu hồi: thao tác nhạy cảm bị từ chối.
            const revoked = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(otherToken))
                .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
            expect(revoked.status).toBe(401);
        });

        it('mật khẩu hiện tại sai -> 400 gắn vào trường currentPassword (không phải 401)', async () => {
            const { token } = await signUp();
            const res = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(token))
                .send({ currentPassword: 'sai-mat-khau-1', newPassword: NEW_PASSWORD });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
            expect(res.body.error.details[0].path).toBe('currentPassword');
        });

        it('thiếu mật khẩu hiện tại -> 400; thiếu mật khẩu mới -> 400 (không phải 500)', async () => {
            const { token } = await signUp();
            const missingCurrent = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(token))
                .send({ newPassword: NEW_PASSWORD });
            expect(missingCurrent.status).toBe(400);
            expect(missingCurrent.body.error.details[0].path).toBe('currentPassword');

            const missingNew = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(token))
                .send({ currentPassword: PASSWORD });
            expect(missingNew.status).toBe(400);
            expect(missingNew.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('sai 5 lần thì tài khoản tạm khoá -> 423 ACCOUNT_LOCKED', async () => {
            const { token } = await signUp();
            const attempt = () =>
                request(app)
                    .put('/api/v1/me/password')
                    .set(bearer(token))
                    .send({ currentPassword: 'sai-mat-khau-1', newPassword: NEW_PASSWORD });
            const codes: number[] = [];
            for (let i = 0; i < 5; i++) codes.push((await attempt()).status);
            expect(codes).toEqual([400, 400, 400, 400, 423]);
        });

        it('tài khoản chưa có mật khẩu (kiểu Google) đặt được mật khẩu mà không cần mật khẩu hiện tại', async () => {
            const { email, token, userId } = await signUp();
            await pool.query(
                'UPDATE users SET password_hash = NULL, google_sub = $2 WHERE id = $1',
                [userId, `google-${userId}`],
            );

            const res = await request(app)
                .put('/api/v1/me/password')
                .set(bearer(token))
                .send({ newPassword: NEW_PASSWORD });
            expect(res.status).toBe(204);
            expect((await login(email, NEW_PASSWORD)).status).toBe(200);
        });

        it('giới hạn 5 lần/giờ mỗi người dùng -> 429 (createApp({ rateLimit: true }))', async () => {
            const limited = createApp({ rateLimit: true });
            const email = uniqueEmail();
            const reg = await request(limited)
                .post('/api/v1/auth/register')
                .send({ email, password: PASSWORD, displayName: 'An' });
            const token = reg.body.data.accessToken as string;
            const codes: number[] = [];
            for (let i = 0; i < 6; i++) {
                const res = await request(limited)
                    .put('/api/v1/me/password')
                    .set(bearer(token))
                    .send({ currentPassword: PASSWORD });
                codes.push(res.status);
            }
            expect(codes[5]).toBe(429);
        });
    });

    describe('thông báo', () => {
        async function seed(userId: string, count: number) {
            for (let i = 0; i < count; i++) {
                await pool.query(
                    `INSERT INTO notifications (user_id, type, title, created_at)
                     VALUES ($1, 'JOB_SUCCEEDED', $2, now() - make_interval(secs => $3))`,
                    [userId, `Thông báo ${i}`, i],
                );
            }
        }

        it('phân trang, total là số, ?unread=true chỉ lấy chưa đọc', async () => {
            const { token, userId } = await signUp();
            await seed(userId, 5);

            const page = await request(app)
                .get('/api/v1/me/notifications?page=1&limit=2')
                .set(bearer(token));
            expect(page.status).toBe(200);
            expect(page.body.data).toHaveLength(2);
            expect(page.body.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });

            const read = await request(app)
                .post('/api/v1/me/notifications/read')
                .set(bearer(token))
                .send({ ids: [page.body.data[0].id] });
            expect(read.status).toBe(204);

            const unread = await request(app)
                .get('/api/v1/me/notifications?unread=true')
                .set(bearer(token));
            expect(unread.body.meta.total).toBe(4);
        });

        it('đánh dấu tất cả đã đọc, không đụng tới thông báo của người khác', async () => {
            const a = await signUp();
            const b = await signUp();
            await seed(a.userId, 2);
            await seed(b.userId, 2);

            const res = await request(app)
                .post('/api/v1/me/notifications/read')
                .set(bearer(a.token))
                .send({ all: true });
            expect(res.status).toBe(204);

            const mine = await request(app)
                .get('/api/v1/me/notifications?unread=true')
                .set(bearer(a.token));
            expect(mine.body.meta.total).toBe(0);
            const theirs = await request(app)
                .get('/api/v1/me/notifications?unread=true')
                .set(bearer(b.token));
            expect(theirs.body.meta.total).toBe(2);
        });

        it('đánh dấu theo id của người khác thì không có tác dụng', async () => {
            const a = await signUp();
            const b = await signUp();
            await seed(b.userId, 1);
            const theirs = await request(app).get('/api/v1/me/notifications').set(bearer(b.token));

            await request(app)
                .post('/api/v1/me/notifications/read')
                .set(bearer(a.token))
                .send({ ids: [theirs.body.data[0].id] });

            const after = await request(app)
                .get('/api/v1/me/notifications?unread=true')
                .set(bearer(b.token));
            expect(after.body.meta.total).toBe(1);
        });

        it('body sai -> 400 VALIDATION_ERROR', async () => {
            const { token } = await signUp();
            const res = await request(app)
                .post('/api/v1/me/notifications/read')
                .set(bearer(token))
                .send({ ids: [] });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });
    });
});
