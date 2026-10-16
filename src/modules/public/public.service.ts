import { createHash } from 'node:crypto';
import { logger } from '../../config';
import { pool, withTransaction } from '../../db';
import { getMediaStorage } from '../../lib';
import {
    AuthorProfileSchema,
    type EventBatchBody,
    type PaginationMeta,
    type PublicBook,
    type PublicBookCard,
    PublicBookCardSchema,
    PublicBookSchema,
    parseEventBatch,
    SlugSchema,
} from '../../schema';
import type { PublicBooksQuery, ReportBookBody } from './../../schema/api/public.schema';
import { AppError, buildPaginationMeta, fieldError, toOffset } from '../../utils';
import { assetsService } from '../assets/assets.service';
import { publicRepository } from './public.repository';
import type { CardBookRow, NewEvent, PublicBookRow } from './public.types';

export const REPORT_WINDOW_HOURS = 24;

export const publicService = {
    async getPublicBooks(
        q: PublicBooksQuery,
    ): Promise<{ data: PublicBookCard[]; meta: PaginationMeta }> {
        const { rows, total } = await publicRepository.getPublicBooks(pool, {
            q: q.q,
            age: q.age,
            topic: q.topic,
            language: q.language,
            sort: q.sort,
            limit: q.limit,
            offset: toOffset({ page: q.page, limit: q.limit }),
        });
        return {
            data: rows.map(toPublicBookCard),
            meta: buildPaginationMeta({ page: q.page, limit: q.limit }, total),
        };
    },

    async getAuthorProfile(authorId: string) {
        const author = await publicRepository.getAuthorProfile(pool, authorId);
        if (!author) throw new AppError('NOT_FOUND', 'Không tìm thấy tác giả');
        const books = await publicRepository.getPublicBooksOfAuthor(pool, authorId);
        return AuthorProfileSchema.parse({
            author: {
                id: author.id,
                displayName: author.display_name,
                organization: author.organization,
                bio: author.bio,
                avatarUrl: author.avatar_url,
            },
            books: books.map(toPublicBookCard),
        });
    },

    async getAvailableBook(slug: string): Promise<PublicBookRow & { version_id: string }> {
        if (!SlugSchema.safeParse(slug).success)
            throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
        const book = await publicRepository.getBookBySlug(pool, slug);
        if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
        const gone =
            book.deleted_at != null ||
            book.taken_down_at != null ||
            book.visibility === 'PRIVATE' ||
            !book.owner_active;
        if (gone || book.version_id === null) throw new AppError('BOOK_UNAVAILABLE');
        return {
            ...book,
            version_id: book.version_id,
        };
    },

    async getPublicBookBySlug(slug: string): Promise<PublicBook> {
        const b = await this.getAvailableBook(slug);
        const storage = getMediaStorage();
        if (!storage) {
            logger.error('CLOUDINARY_URL chưa được cấu hình, không thể lấy thông tin sách');
            throw new AppError('INTERNAL_ERROR');
        }

        const raw = (publicId: string) => storage.deliveryUrl({ resourceType: 'raw', publicId });

        return PublicBookSchema.parse({
            slug: b.slug,
            title: b.title,
            description: b.description,
            author: { id: b.owner_id, displayName: b.author_name },
            coverUrl:
                b.cover_public_id && b.cover_resource_type
                    ? assetsService.coverUrl({
                          resource_type: b.cover_resource_type,
                          public_id: b.cover_public_id,
                      })
                    : null,
            language: b.language,
            ageMin: b.age_min,
            ageMax: b.age_max,
            version: {
                id: b.version_id,
                versionNo: b.version_no,
                publishedAt: b.published_at?.toISOString(),
            },
            manifestUrl: b.manifest_public_id ? raw(b.manifest_public_id) : undefined,
            pageCount: b.page_count,
            arPageCount: b.ar_page_count,
            downloadBytes: Number(b.total_size_bytes ?? 0),
            printPdfUrl: b.print_pdf_public_id ? raw(b.print_pdf_public_id) : null,
        });
    },

    // --- VIEW EVENTS -----------------------
    async recordViewEvents(input: unknown): Promise<void> {
        const parsed = parseEventBatch(input);
        if (!parsed) throw fieldError('events', 'Lô dữ liệu sự kiện không hợp lệ');

        const { batch } = parsed;
        await withTransaction(async (db) => {
            const target = await publicRepository.getVersionBook(db, batch.bookVersionId);
            if (!target) return;
            const pageIds = [
                ...new Set(batch.events.flatMap((e) => ('pageId' in e ? [e.pageId] : []))),
            ];
            const validPageIds = await publicRepository.getValidPageIds(
                db,
                target.book_id,
                pageIds,
            );
            const events: NewEvent[] = [];
            for (const e of batch.events) {
                if ('pageId' in e && e.pageId !== null && !validPageIds.has(e.pageId)) continue;
                events.push({
                    pageId: 'pageId' in e ? e.pageId : null,
                    event: e.type,
                    objectId: e.type === 'TAP' ? e.objectId : null,
                });
            }
            await publicRepository.insertViewEvents(db, {
                bookId: target.book_id,
                versionId: target.version_id,
                sessionId: batch.sessionId,
                device: batch.device,
                events,
            });
            await publicRepository.addViewCount(
                db,
                target.book_id,
                events.filter((e) => e.event === 'OPEN').length,
            );
        });
    },

    // --- REPORTS -----------------------
    async reportBook(slug: string, body: ReportBookBody): Promise<void> {
        const book = await this.getAvailableBook(slug);
        const fingerprint = createHash('sha256').update(body.deviceId).digest('hex');
        await withTransaction(async (db) => {
            if (body.pageId && !(await publicRepository.isPageInBook(db, book.id, body.pageId))) {
                throw fieldError('pageId', 'Trang không thuộc sách này');
            }
            await publicRepository.lockReporter(db, book.id, fingerprint);

            const recent = await publicRepository.getLastReportWithin(
                db,
                book.id,
                fingerprint,
                REPORT_WINDOW_HOURS,
            );
            if (recent) {
                const retryAfterSeconds = Math.max(
                    1,
                    Math.ceil(
                        (recent.getTime() + REPORT_WINDOW_HOURS * 3600 * 1000 - Date.now()) / 1000,
                    ),
                );
                throw new AppError('RATE_LIMITED', `Bạn đã báo cáo sách này rồi.`, {
                    retryAfterSeconds,
                });
            }
            await publicRepository.insertReport(db, {
                bookId: book.id,
                fingerprint,
                pageId: body.pageId ?? null,
                reason: body.reason,
                note: body.note ? body.note : null,
            });
        });
    },
};
export type { EventBatchBody };

// --- Helpers -------------------------------------------------------------
function toPublicBookCard(r: CardBookRow): PublicBookCard {
    return PublicBookCardSchema.parse({
        slug: r.slug,
        title: r.title,
        coverUrl:
            r.cover_public_id && r.cover_resource_type
                ? assetsService.coverUrl({
                      resource_type: r.cover_resource_type,
                      public_id: r.cover_public_id,
                  })
                : null,
        author: { id: r.owner_id, displayName: r.author_name },
        language: r.language,
        ageMin: r.age_min,
        ageMax: r.age_max,
        arPageCount: r.ar_page_count,
    });
}
