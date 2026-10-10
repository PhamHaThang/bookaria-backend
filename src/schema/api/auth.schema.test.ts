import { describe, expect, it } from 'vitest';
import { EmailSchema, NewPasswordSchema, RegisterBodySchema } from './auth.schema';

describe('EmailSchema', () => {
    it('cắt khoảng trắng và đưa về chữ thường trước khi kiểm tra định dạng', () => {
        expect(EmailSchema.parse('  An@Example.COM ')).toBe('an@example.com');
    });

    it('từ chối email sai định dạng', () => {
        expect(EmailSchema.safeParse('khong-phai-email').success).toBe(false);
    });
});

describe('NewPasswordSchema', () => {
    it('tối thiểu 8 ký tự', () => {
        expect(NewPasswordSchema.safeParse('1234567').success).toBe(false);
        expect(NewPasswordSchema.safeParse('12345678').success).toBe(true);
    });

    it('giới hạn tính theo byte (bcrypt chỉ lấy 72 byte đầu)', () => {
        expect(NewPasswordSchema.safeParse('a'.repeat(72)).success).toBe(true);
        expect(NewPasswordSchema.safeParse('a'.repeat(73)).success).toBe(false);
        // 'ế' là 3 byte trong UTF-8: 24 ký tự = 72 byte vẫn qua, 25 ký tự = 75 byte bị từ chối.
        expect(NewPasswordSchema.safeParse('ế'.repeat(24)).success).toBe(true);
        expect(NewPasswordSchema.safeParse('ế'.repeat(25)).success).toBe(false);
    });
});

describe('RegisterBodySchema', () => {
    it('chuẩn hoá email và họ tên', () => {
        const parsed = RegisterBodySchema.parse({
            email: ' A@X.com ',
            password: '12345678',
            displayName: '  An  ',
        });
        expect(parsed).toEqual({ email: 'a@x.com', password: '12345678', displayName: 'An' });
    });
});
