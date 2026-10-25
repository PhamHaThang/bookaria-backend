import { pool, withTransaction } from '../../db';
import {
    type BookDetail,
    BookDetailSchema,
    type BookSummary,
    BookSummarySchema,
    type BookVisibility,
    type CreateBookBody,
    type CreateBookResult,
    CreateBookResultSchema,
    type ListBooksQuery,
    type PaginationMeta,
    type PaginationQuery,
    pageWidthMm,
    TrashBookItemSchema,
    type UpdateBookBody,
} from '../../schema';
import { AppError, buildPaginationMeta, fieldError, toOffset } from '../../utils';
import { assetsService } from '../assets/assets.service';
import { pagesService } from '../pages/pages.service';
import { PAGE_ASPECT, TRASH_DAYS } from './books.constants';
import { booksRepository } from './books.repository';
import type { BookRow } from './books.types';

export const booksService = {
    async getBooks(
        userId: string,
        q: ListBooksQuery,
    ): Promise<{ rows: BookSummary[]; meta: PaginationMeta }> {
        const { rows, total } = await booksRepository.getBooks(pool, userId, {
            q: q.q,
            status: q.status,
            sort: q.sort,
            limit: q.limit,
            offset: toOffset(q),
        });
        return { rows: rows.map(toSummary), meta: buildPaginationMeta(q, total) };
    },
    async getTrashBooks(
        userId: string,
        q: PaginationQuery,
    ): Promise<{ rows: BookSummary[]; meta: PaginationMeta }> {
        const { rows, total } = await booksRepository.getTrashBooks(pool, userId, {
            trashDays: TRASH_DAYS,
            limit: q.limit,
            offset: toOffset(q),
        });
        const data = rows.map((b) =>
            TrashBookItemSchema.parse({ ...toSummary(b), deletedAt: b.deleted_at?.toISOString() }),
        );
        return { rows: data, meta: buildPaginationMeta(q, total) };
    },
    async getBookById(userId: string, bookId: string): Promise<BookDetail> {
        const book = await booksRepository.getDetailBook(pool, userId, bookId);
        if (!book) throw new AppError('NOT_FOUND');
        return BookDetailSchema.parse({
            ...toSummary(book),
            description: book.description,
            ageMin: book.age_min,
            ageMax: book.age_max,
            language: book.language,
            topic: book.topic,
            pageFormat: book.page_format,
            pageAspect: Number(book.page_aspect),
            pageWidthMm: Number(book.page_width_mm),
            slug: book.slug,
            currentVersion:
                book.version_no === null || book.version_published_at === null
                    ? null
                    : {
                          versionNo: book.version_no,
                          publishedAt: book.version_published_at.toISOString(),
                      },
            pages: await pagesService.getPageSummaries(pool, bookId),
        });
    },
    async createBook(userId: string, body: CreateBookBody): Promise<CreateBookResult> {
        if (body.source.type === 'TEMPLATE') {
            throw fieldError(
                'source',
                'Tạo sách từ mẫu chưa được hỗ trợ. Vui lòng tạo sách trống.',
            );
        }
        const id = await booksRepository.insertBook(pool, userId, {
            title: body.title,
            description: body.description ?? null,
            ageMin: body.ageMin ?? null,
            ageMax: body.ageMax ?? null,
            language: body.language ?? null,
            topic: body.topic ?? null,
            pageFormat: body.pageFormat ?? null,
            pageAspect:
                body.pageFormat === 'CUSTOM'
                    ? (body.pageAspect as number)
                    : PAGE_ASPECT[body.pageFormat],
            pageWidthMm: pageWidthMm(body.pageFormat, body.pageWidthMm),
        });
        const book = await booksRepository.getBookSummary(pool, userId, id);
        if (!book) throw new AppError('NOT_FOUND');
        return CreateBookResultSchema.parse({
            book: {
                id: book.id,
                title: book.title,
                status: book.status,
                visibility: book.visibility,
                pageCount: book.page_count,
            },
        });
    },
    async updateBook(userId: string, bookId: string, body: UpdateBookBody): Promise<BookSummary> {
        await withTransaction(async (db) => {
            const currentBook = await booksRepository.lockEditableBook(db, userId, bookId);
            if (!currentBook) throw new AppError('NOT_FOUND');

            const changes: Record<string, string | number | null> = {};
            if (body.title !== undefined) changes.title = body.title;
            if (body.description !== undefined) changes.description = blankToNull(body.description);
            if (body.language !== undefined) changes.language = blankToNull(body.language);
            if (body.topic !== undefined) changes.topic = blankToNull(body.topic);
            if (body.coverAssetId === null) changes.cover_asset_id = null;
            if (typeof body.coverAssetId === 'string') {
                // Chỉ cho phép sử dụng ảnh của người dùng hoặc thư viện chung để làm ảnh bìa.
                if (
                    !(await assetsService.lockAssetForUse(db, userId, body.coverAssetId, 'IMAGE'))
                ) {
                    throw fieldError(
                        'coverAssetId',
                        'Không tìm thấy ảnh này trong thư viện của bạn.',
                    );
                }
                changes.cover_asset_id = body.coverAssetId;
            }
            // Validate age range
            const ageMin = body.ageMin !== undefined ? body.ageMin : currentBook.age_min;
            const ageMax = body.ageMax !== undefined ? body.ageMax : currentBook.age_max;
            if (ageMin !== null && ageMax !== null && ageMax < ageMin) {
                throw fieldError(
                    'ageMax',
                    'Độ tuổi tối đa phải lớn hơn hoặc bằng độ tuổi tối thiểu',
                );
            }
            if (body.ageMin !== undefined) changes.age_min = ageMin;
            if (body.ageMax !== undefined) changes.age_max = ageMax;

            // Validate page format and aspect
            const format = body.pageFormat ?? currentBook.page_format;
            if (
                body.pageFormat !== undefined ||
                body.pageAspect !== undefined ||
                body.pageWidthMm !== undefined
            ) {
                if (format === 'CUSTOM') {
                    if (body.pageAspect !== undefined) changes.page_aspect = body.pageAspect;
                    else if (
                        body.pageFormat !== undefined &&
                        currentBook.page_format !== 'CUSTOM'
                    ) {
                        throw fieldError('pageAspect', 'Khổ tuỳ chỉnh cần nhập tỉ lệ cao/rộng');
                    }
                } else if (body.pageFormat !== undefined) {
                    changes.page_aspect = PAGE_ASPECT[format];
                } // else: a ratio sent for a fixed format is ignored, like at creation
                if (body.pageFormat !== undefined) {
                    changes.page_format = body.pageFormat;
                    if (body.pageFormat !== currentBook.page_format)
                        changes.page_width_mm = pageWidthMm(body.pageFormat);
                }
                if (format === 'CUSTOM' && body.pageWidthMm !== undefined)
                    changes.page_width_mm = body.pageWidthMm;
            }
            // Update the book if there are any changes
            if (Object.keys(changes).length > 0)
                await booksRepository.updateBook(db, bookId, changes);
        });
        // Return the updated book summary
        const book = await booksRepository.getBookSummary(pool, userId, bookId);
        if (!book) throw new AppError('NOT_FOUND');
        return toSummary(book);
    },
    async setVisibility(userId: string, bookId: string, visibility: BookVisibility) {
        await withTransaction(async (db) => {
            const currentBook = await booksRepository.lockEditableBook(db, userId, bookId);
            if (!currentBook) throw new AppError('NOT_FOUND');
            // A book taken down by an administrator may not be opened up again by its author.
            // Making it (still) private is harmless and allowed.
            if (currentBook.taken_down && visibility !== 'PRIVATE') {
                throw new AppError('BOOK_TAKEN_DOWN');
            }
            await booksRepository.updateBook(db, bookId, { visibility });
        });
        const book = await booksRepository.getBookSummary(pool, userId, bookId);
        if (!book) throw new AppError('NOT_FOUND');
        return toSummary(book);
    },
    async deleteBook(userId: string, bookId: string): Promise<void> {
        if (!(await booksRepository.getBookSummary(pool, userId, bookId)))
            throw new AppError('NOT_FOUND');
        // Publishing or exporting must not lose its book halfway.
        if (await booksRepository.hasOpenJob(pool, bookId)) throw new AppError('JOB_IN_PROGRESS');
        if (!(await booksRepository.softDeleteBook(pool, userId, bookId)))
            throw new AppError('NOT_FOUND');
    },

    async restoreBook(userId: string, bookId: string) {
        if (!(await booksRepository.restoreBook(pool, userId, bookId, TRASH_DAYS)))
            throw new AppError('NOT_FOUND');
        const book = await booksRepository.getBookSummary(pool, userId, bookId);
        if (!book) throw new AppError('NOT_FOUND');
        return toSummary(book);
    },
};
// --- Helpers ---------------------------------------------------------------------
const blankToNull = (value: string | null | undefined) =>
    value === undefined || value === null || value === '' ? null : value;
export const toSummary = (b: BookRow) =>
    BookSummarySchema.parse({
        id: b.id,
        title: b.title,
        // The cover address is built from the uploaded image.
        coverUrl:
            b.cover_public_id && b.cover_resource_type
                ? assetsService.coverUrl({
                      resource_type: b.cover_resource_type,
                      public_id: b.cover_public_id,
                  })
                : null,
        status: b.status,
        visibility: b.visibility,
        takenDown: b.taken_down,
        pageCount: b.page_count,
        updatedAt: b.updated_at.toISOString(),
    });
