import { describe, expect, it } from 'vitest';
import { env } from '../../../config';
import { RESET_PASSWORD_TTL_MINUTES, VERIFY_EMAIL_TTL_HOURS } from '../auth.constants';
import {
    escapeHtml,
    passwordChangedMail,
    resetPasswordMail,
    verifyEmailMail,
} from '../auth.emails';

describe('escapeHtml', () => {
    it('thoát các ký tự đặc biệt của HTML', () => {
        expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
            '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
        );
    });
});

describe('verifyEmailMail', () => {
    it('có cả bản text và HTML, link xác nhận chứa token', () => {
        const mail = verifyEmailMail('an@example.com', 'An', 'tok_abc-123');
        expect(mail.to).toBe('an@example.com');
        expect(mail.text).toContain(`${env.STUDIO_URL}/verify-email?token=tok_abc-123`);
        expect(mail.html).toContain(`href="${env.STUDIO_URL}/verify-email?token=tok_abc-123"`);
    });

    it('thời hạn trong thư lấy từ hằng số, không ghi cứng', () => {
        const mail = verifyEmailMail('an@example.com', 'An', 't');
        expect(mail.text).toContain(`${VERIFY_EMAIL_TTL_HOURS} giờ`);
    });

    it('mã hóa token trong URL', () => {
        const mail = verifyEmailMail('an@example.com', 'An', 'a b&c');
        expect(mail.text).toContain('token=a%20b%26c');
        expect(mail.text).not.toContain('token=a b&c');
    });

    it('tên hiển thị do người dùng nhập được thoát trong HTML (chống XSS)', () => {
        const mail = verifyEmailMail('an@example.com', '<script>alert(1)</script>', 't');
        expect(mail.html).not.toContain('<script>');
        expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
});

describe('resetPasswordMail', () => {
    it('link đặt lại mật khẩu chứa token và nêu đúng thời hạn', () => {
        const mail = resetPasswordMail('an@example.com', 'An', 'tok_xyz');
        expect(mail.text).toContain(`${env.STUDIO_URL}/reset-password?token=tok_xyz`);
        expect(mail.text).toContain(`${RESET_PASSWORD_TTL_MINUTES} phút`);
    });
});

describe('passwordChangedMail', () => {
    it('không chứa token, có link tới trang quên mật khẩu', () => {
        const mail = passwordChangedMail('an@example.com', 'An');
        expect(mail.text).not.toContain('token=');
        expect(mail.text).toContain(`${env.STUDIO_URL}/forgot-password`);
    });
});
