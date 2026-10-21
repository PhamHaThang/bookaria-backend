import { describe, expect, it } from 'vitest';
import { generateBookSlug, slugifyTitle } from '../slug';

describe('slug utilities', () => {
    it('chuyển tiếng Việt có dấu thành không dấu và gạch nối', () => {
        expect(slugifyTitle('Sách AR Kỳ Diệu của Bé')).toBe('sach-ar-ky-dieu-cua-be');
        expect(slugifyTitle('Đường Lên Đỉnh Vinh Quang')).toBe('duong-len-dinh-vinh-quang');
    });

    it('loại bỏ ký tự đặc biệt và dấu cách thừa', () => {
        expect(slugifyTitle('   Khám Phá Vũ Trụ @ 2026 !?!   ')).toBe('kham-pha-vu-tru-2026');
    });

    it('giới hạn tối đa 60 ký tự cho phần tiêu đề', () => {
        const longTitle =
            'Một câu chuyện rất dài về một chú khủng long nhỏ bé đi tìm mẹ trên khắp thế gian bao la';
        const slug = slugifyTitle(longTitle);
        expect(slug.length).toBeLessThanOrEqual(60);
        expect(slug).not.toMatch(/-$/);
    });

    it('tránh từ dành riêng trong hệ thống', () => {
        expect(slugifyTitle('admin')).toBe('sach-admin');
        expect(slugifyTitle('api')).toBe('sach-api');
    });

    it('fallback nếu tiêu đề rỗng hoặc toàn ký tự đặc biệt', () => {
        expect(slugifyTitle('!@#$%^&*()')).toBe('sach');
    });

    it('generateBookSlug sinh chuỗi dạng <slug>-<6 base36>', () => {
        const slug = generateBookSlug('Sách Khoa Học');
        expect(slug).toMatch(/^sach-khoa-hoc-[a-z0-9]{6}$/);
    });
});
