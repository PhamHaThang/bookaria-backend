import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { pool } from '../../db';
import { type Mail, setMailer } from '../../lib';
import { REFRESH_TOKEN_COOKIE_NAME } from './auth.constants';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;

const PASSWORD = 'Matkhau-123';
const app = createApp();
const sent: Mail[] = [];

const uniqueEmail = () =>
    `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;

function cookieOf(res: request.Response): string | undefined {
    const header = res.headers['set-cookie'] as string[] | string | undefined;
    const list = Array.isArray(header) ? header : header ? [header] : [];
    const entry = list.find((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`));
    return entry ? entry.split(';')[0]?.split('=')[1] : undefined;
}
const rawSetCookie = (res: request.Response) =>
    ([] as string[])
        .concat((res.headers['set-cookie'] as string[] | string | undefined) ?? [])
        .join('\n');

const withCookie = (r: request.Test, value: string | undefined) =>
    value ? r.set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${value}`) : r;

async function register(email = uniqueEmail(), displayName = 'An') {
    const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, displayName });
    return { email, res };
}
const login = (email: string, password = PASSWORD, remember = false) =>
    request(app).post('/api/v1/auth/login').send({ email, password, remember });

async function waitForMail(to: string, match: RegExp): Promise<Mail> {
    for (let i = 0; i < 100; i++) {
        const mail = [...sent].reverse().find((m) => m.to === to && match.test(m.text));
        if (mail) return mail;
        await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Không thấy thư gửi tới ${to}`);
}
const tokenIn = (mail: Mail) => /token=([^\s&]+)/.exec(mail.text)?.[1] ?? '';

suite('auth (tích hợp)', () => {
    beforeAll(() => {
        setMailer({
            async send(mail) {
                sent.push(mail);
            },
        });
    });

    describe('rate limit (createApp({ rateLimit: true }))', () => {
        it('đăng nhập sai quá 5 lần/phút từ một IP -> 429 RATE_LIMITED', async () => {
            const limited = createApp({ rateLimit: true });
            const attempt = () =>
                request(limited)
                    .post('/api/v1/auth/login')
                    .send({ email: uniqueEmail(), password: 'sai-mat-khau-1' });
            const codes: number[] = [];
            for (let i = 0; i < 6; i++) codes.push((await attempt()).status);
            expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
        });
    });

    describe('register', () => {
        it('tạo tài khoản, đăng nhập luôn, đặt cookie phiên và gửi thư xác minh', async () => {
            const { email, res } = await register();
            expect(res.status).toBe(201);
            expect(res.body.data.accessToken).toEqual(expect.any(String));
            expect(res.body.data.user).toMatchObject({
                email,
                emailVerified: false,
                role: 'AUTHOR',
            });
            expect(JSON.stringify(res.body)).not.toContain('refreshToken');
            expect(cookieOf(res)).toBeTruthy();
            expect(rawSetCookie(res)).toMatch(/HttpOnly/i);
            expect(rawSetCookie(res)).not.toMatch(/max-age/i); // cookie phiên (remember = false)
            expect((await waitForMail(email, /verify-email\?token=/)).subject).toBeTruthy();
        });

        it('email đã tồn tại (khác hoa thường, thừa khoảng trắng) -> 409 EMAIL_TAKEN', async () => {
            const { email } = await register();
            const res = await request(app)
                .post('/api/v1/auth/register')
                .send({ email: ` ${email.toUpperCase()} `, password: PASSWORD, displayName: 'B' });
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('EMAIL_TAKEN');
        });

        it('dữ liệu sai -> 400 VALIDATION_ERROR', async () => {
            const res = await request(app).post('/api/v1/auth/register').send({ email: 'x' });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
            expect(res.body.error.details.length).toBeGreaterThan(0);
        });

        it('mật khẩu tính theo byte: 24 chữ "ế" (72 byte) qua, 25 chữ (75 byte) bị từ chối', async () => {
            const ok = await request(app)
                .post('/api/v1/auth/register')
                .send({ email: uniqueEmail(), password: 'ế'.repeat(24), displayName: 'A' });
            expect(ok.status).toBe(201);

            const tooLong = await request(app)
                .post('/api/v1/auth/register')
                .send({ email: uniqueEmail(), password: 'ế'.repeat(25), displayName: 'A' });
            expect(tooLong.status).toBe(400);
            expect(tooLong.body.error.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('verify-email', () => {
        it('xác minh thành công một lần, dùng lại hoặc token rác -> 400 TOKEN_INVALID', async () => {
            const { email } = await register();
            const token = tokenIn(await waitForMail(email, /verify-email\?token=/));

            const ok = await request(app).post('/api/v1/auth/verify-email').send({ token });
            expect(ok.status).toBe(200);
            expect(ok.body.data.emailVerified).toBe(true);

            const again = await request(app).post('/api/v1/auth/verify-email').send({ token });
            expect(again.status).toBe(400);
            expect(again.body.error.code).toBe('TOKEN_INVALID');

            const garbage = await request(app)
                .post('/api/v1/auth/verify-email')
                .send({ token: 'rac' });
            expect(garbage.body.error.code).toBe('TOKEN_INVALID');

            const me = await login(email);
            expect(me.body.data.user.emailVerified).toBe(true);
        });
    });

    describe('resend-verification', () => {
        it('cần access token', async () => {
            const res = await request(app).post('/api/v1/auth/resend-verification');
            expect(res.status).toBe(401);
        });

        it('gửi lại ngay sau đăng ký bị chặn bởi thời gian chờ', async () => {
            const { res } = await register();
            const again = await request(app)
                .post('/api/v1/auth/resend-verification')
                .set('Authorization', `Bearer ${res.body.data.accessToken}`);
            expect(again.status).toBe(429);
            expect(again.body.error.code).toBe('RATE_LIMITED');
            const { retryAfterSeconds } = again.body.error.details;
            expect(Number.isInteger(retryAfterSeconds)).toBe(true);
            expect(retryAfterSeconds).toBeGreaterThan(0);
        });

        it('hết thời gian chờ thì gửi lại được và token cũ mất hiệu lực', async () => {
            const { email, res } = await register();
            const oldToken = tokenIn(await waitForMail(email, /verify-email\?token=/));
            await pool.query(
                `UPDATE auth_tokens SET created_at = now() - interval '5 minutes'
                  WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
                [email],
            );
            const again = await request(app)
                .post('/api/v1/auth/resend-verification')
                .set('Authorization', `Bearer ${res.body.data.accessToken}`);
            expect(again.status).toBe(204);

            const old = await request(app)
                .post('/api/v1/auth/verify-email')
                .send({ token: oldToken });
            expect(old.body.error.code).toBe('TOKEN_INVALID');
        });
    });

    describe('login', () => {
        it('đúng mật khẩu -> 200; remember=true thì cookie bền (Max-Age)', async () => {
            const { email } = await register();
            const res = await login(email, PASSWORD, true);
            expect(res.status).toBe(200);
            expect(res.body.data.expiresIn).toBeGreaterThan(0);
            expect(rawSetCookie(res)).toMatch(/max-age=\d+/i);
        });

        it('sai mật khẩu và email không tồn tại cho cùng một thông báo (không lộ email)', async () => {
            const { email } = await register();
            const wrong = await login(email, 'sai-mat-khau-1');
            const unknown = await login(uniqueEmail(), 'sai-mat-khau-1');
            expect(wrong.status).toBe(401);
            expect(unknown.status).toBe(401);
            expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
            expect(wrong.body.error.message).toBe(unknown.body.error.message);
            expect(wrong.body.error.message).not.toMatch(/\d/); // không báo số lần còn lại
        });

        it('sai 5 lần liên tiếp thì khoá tạm, kể cả khi sau đó nhập đúng', async () => {
            const { email } = await register();
            const codes: number[] = [];
            for (let i = 0; i < 5; i++) codes.push((await login(email, 'sai-sai-sai-1')).status);
            expect(codes).toEqual([401, 401, 401, 401, 423]);

            const locked = await login(email, PASSWORD);
            expect(locked.status).toBe(423);
            expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
            expect(new Date(locked.body.error.details.lockedUntil).getTime()).toBeGreaterThan(
                Date.now(),
            );
        });

        it('hết thời gian khoá thì đăng nhập lại được', async () => {
            const { email } = await register();
            for (let i = 0; i < 5; i++) await login(email, 'sai-sai-sai-1');
            await pool.query(
                `UPDATE users SET locked_until = now() - interval '1 minute' WHERE email = $1`,
                [email],
            );
            expect((await login(email, PASSWORD)).status).toBe(200);
        });
    });

    describe('refresh', () => {
        it('xoay vòng refresh token, cấp access token mới', async () => {
            const { email } = await register();
            const first = cookieOf(await login(email)) as string;
            const res = await withCookie(request(app).post('/api/v1/auth/refresh'), first);
            expect(res.status).toBe(200);
            expect(res.body.data.accessToken).toEqual(expect.any(String));
            const second = cookieOf(res);
            expect(second).toBeTruthy();
            expect(second).not.toBe(first);
        });

        it('không có cookie -> 401', async () => {
            const res = await request(app).post('/api/v1/auth/refresh');
            expect(res.status).toBe(401);
            expect(res.body.error.code).toBe('UNAUTHENTICATED');
        });

        it('dùng lại token cũ trong thời gian ân hạn thì cho qua (hai tab refresh cùng lúc)', async () => {
            const { email } = await register();
            const first = cookieOf(await login(email)) as string;
            await withCookie(request(app).post('/api/v1/auth/refresh'), first);
            const replay = await withCookie(request(app).post('/api/v1/auth/refresh'), first);
            expect(replay.status).toBe(200);
        });

        it('dùng lại token cũ sau thời gian ân hạn -> coi là bị đánh cắp, thu hồi cả phiên', async () => {
            const { email } = await register();
            const first = cookieOf(await login(email)) as string;
            const rotated = await withCookie(request(app).post('/api/v1/auth/refresh'), first);
            const second = cookieOf(rotated) as string;

            await pool.query(
                `UPDATE auth_sessions SET last_used_at = now() - interval '1 minute'
                  WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
                [email],
            );
            const replay = await withCookie(request(app).post('/api/v1/auth/refresh'), first);
            expect(replay.status).toBe(401);

            const legit = await withCookie(request(app).post('/api/v1/auth/refresh'), second);
            expect(legit.status).toBe(401);
        });

        it('Origin lạ -> 403 FORBIDDEN, Origin hợp lệ hoặc không có Origin thì qua', async () => {
            const { email } = await register();
            const cookie = cookieOf(await login(email)) as string;

            const evil = await withCookie(request(app).post('/api/v1/auth/refresh'), cookie).set(
                'Origin',
                'https://evil.example',
            );
            expect(evil.status).toBe(403);
            expect(evil.body.error.code).toBe('FORBIDDEN');

            const good = await withCookie(request(app).post('/api/v1/auth/refresh'), cookie).set(
                'Origin',
                'http://localhost:5173',
            );
            expect(good.status).toBe(200);
        });
    });

    describe('logout', () => {
        it('thu hồi phiên theo cookie, không cần access token; refresh sau đó -> 401', async () => {
            const { email } = await register();
            const cookie = cookieOf(await login(email)) as string;

            const out = await withCookie(request(app).post('/api/v1/auth/logout'), cookie);
            expect(out.status).toBe(204);
            expect(rawSetCookie(out)).toMatch(new RegExp(`${REFRESH_TOKEN_COOKIE_NAME}=;`));

            const after = await withCookie(request(app).post('/api/v1/auth/refresh'), cookie);
            expect(after.status).toBe(401);
        });

        it('idempotent: không có cookie hoặc cookie sai vẫn 204', async () => {
            expect((await request(app).post('/api/v1/auth/logout')).status).toBe(204);
            const junk = await withCookie(request(app).post('/api/v1/auth/logout'), 'khong-hop-le');
            expect(junk.status).toBe(204);
        });
    });

    describe('forgot-password / reset-password', () => {
        it('email không tồn tại vẫn trả 200 và không gửi thư', async () => {
            const before = sent.length;
            const res = await request(app)
                .post('/api/v1/auth/forgot-password')
                .send({ email: uniqueEmail() });
            expect(res.status).toBe(200);
            await new Promise((r) => setTimeout(r, 150));
            expect(sent.length).toBe(before);
        });

        it('đặt lại mật khẩu: thu hồi mọi phiên, đổi mật khẩu, token chỉ dùng một lần', async () => {
            const { email } = await register();
            const liveCookie = cookieOf(await login(email)) as string;

            const fp = await request(app).post('/api/v1/auth/forgot-password').send({ email });
            expect(fp.status).toBe(200);
            const token = tokenIn(await waitForMail(email, /reset-password\?token=/));

            const weak = await request(app)
                .post('/api/v1/auth/reset-password')
                .send({ token, newPassword: 'ngan' });
            expect(weak.status).toBe(400); // schema chặn, token chưa bị dùng

            const reset = await request(app)
                .post('/api/v1/auth/reset-password')
                .send({ token, newPassword: 'Matkhau-moi-456' });
            expect(reset.status).toBe(200);

            const oldSession = await withCookie(
                request(app).post('/api/v1/auth/refresh'),
                liveCookie,
            );
            expect(oldSession.status).toBe(401);
            expect((await login(email, PASSWORD)).status).toBe(401);
            expect((await login(email, 'Matkhau-moi-456')).status).toBe(200);

            const reuse = await request(app)
                .post('/api/v1/auth/reset-password')
                .send({ token, newPassword: 'Abcdefgh-1234' });
            expect(reuse.status).toBe(400);
            expect(reuse.body.error.code).toBe('TOKEN_INVALID');
        });

        it('token rác -> 400 TOKEN_INVALID', async () => {
            const res = await request(app)
                .post('/api/v1/auth/reset-password')
                .send({ token: 'rac', newPassword: 'Matkhau-moi-456' });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('TOKEN_INVALID');
        });

        it('chỉ gửi tối đa 3 thư mỗi giờ cho một địa chỉ (âm thầm bỏ qua phần vượt)', async () => {
            const { email } = await register();
            for (let i = 0; i < 5; i++) {
                const res = await request(app).post('/api/v1/auth/forgot-password').send({ email });
                expect(res.status).toBe(200);
                await new Promise((r) => setTimeout(r, 120));
            }
            await new Promise((r) => setTimeout(r, 300));
            const resets = sent.filter(
                (m) => m.to === email && /reset-password\?token=/.test(m.text),
            );
            expect(resets.length).toBe(3);
        });
    });
});
