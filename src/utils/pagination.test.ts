import { describe, expect, it } from 'vitest';
import { PaginationQuerySchema } from '../schema';
import { buildPaginationMeta, toOffset } from './pagination';

describe('PaginationQuerySchema', () => {
    it('ép chuỗi thành số và mặc định page=1, limit=20', () => {
        expect(PaginationQuerySchema.parse({ page: '3', limit: '10' })).toEqual({
            page: 3,
            limit: 10,
        });
        expect(PaginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    });

    it('từ chối giá trị ngoài khoảng', () => {
        expect(PaginationQuerySchema.safeParse({ page: '0' }).success).toBe(false);
        expect(PaginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    });
});

describe('toOffset / buildPaginationMeta', () => {
    it('tính offset từ page và limit', () => {
        expect(toOffset({ page: 3, limit: 10 })).toEqual({ limit: 10, offset: 20 });
    });

    it('tính tổng số trang, kể cả khi không có dữ liệu', () => {
        expect(buildPaginationMeta({ page: 1, limit: 20 }, 45).totalPages).toBe(3);
        expect(buildPaginationMeta({ page: 1, limit: 20 }, 0).totalPages).toBe(0);
    });
});
