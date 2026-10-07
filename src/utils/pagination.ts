import type { PaginationMeta, PaginationQuery } from '../schema';

/**
 * Convert a pagination query to an offset.
 */
export function toOffset({ page, limit }: PaginationQuery): { limit: number; offset: number } {
    return { limit, offset: (page - 1) * limit };
}

/**
 * Build pagination metadata.
 */
export function buildPaginationMeta(query: PaginationQuery, total: number): PaginationMeta {
    return {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
    };
}
