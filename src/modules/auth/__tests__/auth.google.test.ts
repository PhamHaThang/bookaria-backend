import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import { createGoogleVerifier, type GoogleProfile, setGoogleVerifier } from '../../../lib';
import { REFRESH_TOKEN_COOKIE_NAME } from '../auth.constants';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;

const PASSWORD = 'Matkhau-123';
const app = createApp();

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const uniqueEmail = () => `g${unique()}@example.com`;

/** Giả lập Google: token là một khóa tra trong bảng, nên test không gọi mạng. */
const profiles = new Map<string, GoogleProfile>();
function googleToken(profile: Partial<GoogleProfile> & { email: string }): string {
    const full: GoogleProfile = {
        sub: `sub-${unique()}`,
        emailVerified: true,
        name: 'An Google',
        ...profile,
    };
    const token = `tok-${unique()}`;
    profiles.set(token, full);
    return token;
}

const loginWithGoogle = (idToken: string) =>
    request(app).post('/api/v1/auth/google').send({ idToken });

suite('auth: đăng nhập bằng Google (tích hợp)', () => {
    beforeAll(() => {
        setGoogleVerifier({ verify: async (token) => profiles.get(token) ?? null });
    });
    afterEach(() => setGoogleVerifier({ verify: async (token) => profiles.get(token) ?? null }));

    it('email mới: tạo tài khoản, đã xác minh email, có cookie phiên', async () => {
        const email = uniqueEmail();
        const res = await loginWithGoogle(googleToken({ email, name: 'Bình' }));

        expect(res.status).toBe(200);
        expect(res.body.data.accessToken).toEqual(expect.any(String));
        expect(res.body.data.user).toMatchObject({
            email,
            displayName: 'Bình',
            emailVerified: true,
            role: 'AUTHOR',
        });
        const cookies = ([] as string[]).concat(
            (res.headers['set-cookie'] as string[] | string | undefined) ?? [],
        );
        expect(cookies.some((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))).toBe(true);
    });

    it('đăng nhập lại cùng tài khoản Google không tạo bản sao', async () => {
        const profile = { email: uniqueEmail(), sub: `sub-${unique()}` };
        const first = await loginWithGoogle(googleToken(profile));
        const second = await loginWithGoogle(googleToken(profile));
        expect(second.status).toBe(200);
        expect(second.body.data.user.id).toBe(first.body.data.user.id);
    });

    it('trùng email với tài khoản mật khẩu đã xác minh: gắn vào tài khoản đó, mật khẩu vẫn dùng được', async () => {
        const email = uniqueEmail();
        const reg = await request(app)
            .post('/api/v1/auth/register')
            .send({ email, password: PASSWORD, displayName: 'An' });
        await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [
            reg.body.data.user.id,
        ]);

        const res = await loginWithGoogle(googleToken({ email }));
        expect(res.status).toBe(200);
        expect(res.body.data.user.id).toBe(reg.body.data.user.id);

        const withPassword = await request(app)
            .post('/api/v1/auth/login')
            .send({ email, password: PASSWORD });
        expect(withPassword.status).toBe(200);
    });

    it('trùng email với tài khoản CHƯA xác minh: gắn Google nhưng bỏ mật khẩu và đăng xuất phiên cũ', async () => {
        const email = uniqueEmail();
        const reg = await request(app)
            .post('/api/v1/auth/register')
            .send({ email, password: PASSWORD, displayName: 'Kẻ tấn công' });
        const oldToken = reg.body.data.accessToken as string;

        const res = await loginWithGoogle(googleToken({ email }));
        expect(res.status).toBe(200);
        expect(res.body.data.user.emailVerified).toBe(true);

        // Mật khẩu do người đăng ký trước đặt không còn dùng được.
        const withPassword = await request(app)
            .post('/api/v1/auth/login')
            .send({ email, password: PASSWORD });
        expect(withPassword.status).toBe(401);

        // Phiên cũ bị thu hồi: thao tác cần phiên còn sống bị từ chối.
        const revoked = await request(app)
            .put('/api/v1/me/password')
            .set('Authorization', `Bearer ${oldToken}`)
            .send({ currentPassword: PASSWORD, newPassword: 'Matkhau-456-moi' });
        expect(revoked.status).toBe(401);
    });

    it('Google chưa xác nhận email -> 401 INVALID_CREDENTIALS, không tạo tài khoản', async () => {
        const email = uniqueEmail();
        const res = await loginWithGoogle(googleToken({ email, emailVerified: false }));
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

        const { rowCount } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
        expect(rowCount).toBe(0);
    });

    it('token không hợp lệ -> 401', async () => {
        const res = await loginWithGoogle('token-khong-ton-tai');
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('thiếu idToken -> 400 VALIDATION_ERROR', async () => {
        const res = await request(app).post('/api/v1/auth/google').send({});
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('tài khoản bị khoá bởi quản trị viên -> 423 ACCOUNT_LOCKED', async () => {
        const email = uniqueEmail();
        const profile = { email, sub: `sub-${unique()}` };
        await loginWithGoogle(googleToken(profile));
        await pool.query(`UPDATE users SET status = 'LOCKED' WHERE email = $1`, [email]);

        const res = await loginWithGoogle(googleToken(profile));
        expect(res.status).toBe(423);
        expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('email đã gắn với một tài khoản Google khác -> 401', async () => {
        const email = uniqueEmail();
        await loginWithGoogle(googleToken({ email, sub: `sub-${unique()}` }));
        const res = await loginWithGoogle(googleToken({ email, sub: `sub-${unique()}` }));
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('chưa cấu hình GOOGLE_CLIENT_ID -> 500 INTERNAL_ERROR rõ ràng', async () => {
        setGoogleVerifier(undefined);
        const res = await loginWithGoogle('bat-ky');
        // Môi trường test không đặt GOOGLE_CLIENT_ID nên getGoogleVerifier() trả undefined.
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
});

describe('createGoogleVerifier', () => {
    it('chuỗi không phải JWT bị từ chối (null), không ném lỗi', async () => {
        const verifier = createGoogleVerifier('client-id.apps.googleusercontent.com');
        await expect(verifier.verify('khong-phai-jwt')).resolves.toBeNull();
    });
});
