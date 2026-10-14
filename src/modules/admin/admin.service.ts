import { pool, withTransaction } from '../../db';
import { hashPassword } from '../../lib';
import type { Auth } from '../../middlewares';
import {
    type AdminBookDetail,
    AdminBookDetailSchema,
    type AdminBookItem,
    AdminBookItemSchema,
    type AdminBooksQuery,
    type AdminCreateUserBody,
    type AdminDashboard,
    AdminDashboardSchema,
    type AdminUpdateUserBody,
    type AdminUpdateUserResult,
    AdminUpdateUserResultSchema,
    type AdminUser,
    type AdminUserDetails,
    AdminUserDetailsSchema,
    AdminUserSchema,
    type AdminUsersQuery,
    type BookSummary,
    BookSummarySchema,
    type DismissReportsResult,
    DismissReportsResultSchema,
    MARKER_RULES,
    type ModerationItem,
    ModerationItemSchema,
    type ModerationNoteBody,
    type PaginationMeta,
    type PaginationQuery,
    type TakedownBody,
    type TakedownResult,
    TakedownResultSchema,
} from '../../schema';
import { AppError, buildPaginationMeta, lockedByAdminError, toOffset } from '../../utils';
import { adminRepository } from './admin.repository';
import type { AdminBookRow, AdminUserRow, ModerationBookRow } from './admin.types';

export const adminService = {
    async assertAdmin(auth: Auth): Promise<void> {
        const user = await adminRepository.findCurrentAdmin(pool, auth.userId, auth.sessionId);
        if (!user) throw new AppError('UNAUTHENTICATED');
        if (user.status === 'LOCKED') throw lockedByAdminError();
        if (user.role !== 'ADMIN') throw new AppError('FORBIDDEN');
        if (!user.session_active) throw new AppError('UNAUTHENTICATED');
    },

    async getDashboard(): Promise<AdminDashboard> {
        const { metrics, publishedPerDay, auditActionsToday } =
            await adminRepository.getDashboard(pool);
        return AdminDashboardSchema.parse({
            users: metrics.users,
            publishedBooks: metrics.published_books,
            storageUsedBytes: Number(metrics.storage_used_bytes),
            failedJobs24h: metrics.failed_jobs_24h,
            openReports: metrics.open_reports,
            publishedPerDay,
            auditActionsToday,
        });
    },

    async getModerationQueue(
        query: PaginationQuery,
    ): Promise<{ rows: ModerationItem[]; meta: PaginationMeta }> {
        const { rows, total } = await adminRepository.getModerationQueue(
            pool,
            query.limit,
            toOffset(query),
        );
        return {
            rows: rows.map((row) =>
                ModerationItemSchema.parse({
                    book: {
                        id: row.book_id,
                        title: row.book_title,
                        author: { id: row.author_id, displayName: row.author_display_name },
                    },
                    reportCount: row.report_count,
                    reasons: row.reasons,
                    lastReportedAt: row.last_reported_at.toISOString(),
                }),
            ),
            meta: buildPaginationMeta(query, total),
        };
    },

    async getModerationBooks(
        query: AdminBooksQuery,
    ): Promise<{ rows: AdminBookItem[]; meta: PaginationMeta }> {
        const { rows, total } = await adminRepository.getModerationBooks(
            pool,
            query,
            toOffset(query),
        );
        return {
            rows: rows.map((row) =>
                AdminBookItemSchema.parse({
                    ...toModerationBookSummary(row),
                    author: { id: row.author_id, displayName: row.author_display_name },
                    reportCount: row.report_count,
                }),
            ),
            meta: buildPaginationMeta(query, total),
        };
    },

    async getModerationBook(bookId: string): Promise<AdminBookDetail> {
        const book = await adminRepository.findModerationBook(pool, bookId);
        if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
        const [pages, reports] = await Promise.all([
            adminRepository.getModerationPages(pool, bookId),
            adminRepository.getBookReports(pool, bookId),
        ]);
        return AdminBookDetailSchema.parse({
            book: {
                ...toModerationBookSummary(book),
                author: { id: book.author_id, displayName: book.author_display_name },
                description: book.description,
                takenDownReason: book.taken_down_reason,
                pages: pages.map((page) => ({
                    id: page.id,
                    orderIndex: page.order_index,
                    title: page.title,
                    thumbnailUrl: page.thumbnail_url,
                    markerMode: page.marker_mode,
                    markerNumber: page.marker_number,
                    markerScore: page.marker_score,
                    markerWarnings:
                        page.marker_mode !== 'CUSTOM_MARKER'
                            ? []
                            : page.marker_score === null
                              ? ['NOT_SCORED']
                              : page.marker_score < MARKER_RULES.minPublishScore
                                ? ['LOW_SCORE']
                                : [],
                    objectCount: page.object_count,
                })),
            },
            reports: reports.map((report) => ({
                id: report.id,
                reason: report.reason,
                note: report.note,
                status: report.status,
                createdAt: report.created_at.toISOString(),
                handledAt: report.handled_at?.toISOString() ?? null,
            })),
        });
    },

    async takeDownBook(actor: Auth, bookId: string, body: TakedownBody): Promise<TakedownResult> {
        return withTransaction(async (db) => {
            const book = await adminRepository.lockModerationBook(db, bookId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
            if (book.taken_down_at !== null) {
                return TakedownResultSchema.parse({
                    book: { id: book.id, visibility: 'PRIVATE', takenDown: true },
                    resolvedReports: 0,
                });
            }

            await adminRepository.takeDownBook(db, bookId, body.reason);
            const resolvedReports = await adminRepository.handleOpenReports(
                db,
                bookId,
                actor.userId,
                'ACTIONED',
                body.reason,
            );
            await adminRepository.insertBookNotification(db, book.owner_id, bookId, {
                type: 'BOOK_TAKEN_DOWN',
                title: 'Sách đã bị gỡ',
                body: `“${book.title}” đã bị gỡ: ${body.reason}`,
            });
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'TAKE_DOWN_BOOK',
                bookId,
                {
                    fromVisibility: book.visibility,
                    toVisibility: 'PRIVATE',
                    reason: body.reason,
                    resolvedReports,
                },
                'BOOK',
            );
            return TakedownResultSchema.parse({
                book: { id: book.id, visibility: 'PRIVATE', takenDown: true },
                resolvedReports,
            });
        });
    },

    async reinstateBook(actor: Auth, bookId: string, body: ModerationNoteBody) {
        await withTransaction(async (db) => {
            const book = await adminRepository.lockModerationBook(db, bookId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
            if (book.taken_down_at === null) return;

            const restoredVisibility =
                book.owner_status === 'ACTIVE'
                    ? (book.visibility_before_lock ?? 'PRIVATE')
                    : 'PRIVATE';
            await adminRepository.reinstateBook(
                db,
                bookId,
                restoredVisibility,
                book.owner_status === 'ACTIVE',
            );
            await adminRepository.insertBookNotification(db, book.owner_id, bookId, {
                type: 'BOOK_REINSTATED',
                title: 'Sách đã được khôi phục',
                body: body.note || `“${book.title}” đã được quản trị viên khôi phục.`,
            });
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'REINSTATE_BOOK',
                bookId,
                {
                    fromVisibility: book.visibility,
                    toVisibility: restoredVisibility,
                    note: body.note ?? null,
                },
                'BOOK',
            );
        });

        const book = await adminRepository.findModerationBook(pool, bookId);
        if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
        return BookSummarySchema.parse(toModerationBookSummary(book));
    },

    async dismissReports(
        actor: Auth,
        bookId: string,
        body: ModerationNoteBody,
    ): Promise<DismissReportsResult> {
        return withTransaction(async (db) => {
            const book = await adminRepository.lockModerationBook(db, bookId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
            const dismissedReports = await adminRepository.handleOpenReports(
                db,
                bookId,
                actor.userId,
                'DISMISSED',
                body.note ?? null,
            );
            if (dismissedReports > 0) {
                await adminRepository.insertAuditLog(
                    db,
                    actor.userId,
                    'DISMISS_REPORT',
                    bookId,
                    { dismissedReports, note: body.note ?? null },
                    'BOOK',
                );
            }
            return DismissReportsResultSchema.parse({ dismissedReports });
        });
    },

    async getUsers(query: AdminUsersQuery): Promise<{ rows: AdminUser[]; meta: PaginationMeta }> {
        const { rows, total } = await adminRepository.getUsers(pool, query, toOffset(query));
        return {
            rows: rows.map(toAdminUser),
            meta: buildPaginationMeta(query, total),
        };
    },

    async createUser(actor: Auth, body: AdminCreateUserBody): Promise<AdminUser> {
        const passwordHash = await hashPassword(body.password);
        let userId: string;
        try {
            userId = await withTransaction(async (db) => {
                const userId = await adminRepository.insertUser(db, {
                    email: body.email,
                    passwordHash,
                    displayName: body.displayName,
                    role: body.role,
                    storageQuotaBytes: body.storageQuotaBytes,
                });
                await adminRepository.insertAuditLog(db, actor.userId, 'CREATE_USER', userId, {
                    email: body.email,
                    displayName: body.displayName,
                    role: body.role,
                    status: 'ACTIVE',
                    storageQuotaBytes: body.storageQuotaBytes,
                });
                return userId;
            });
        } catch (error) {
            if (isUniqueViolation(error)) throw new AppError('EMAIL_TAKEN');
            throw error;
        }

        const user = await adminRepository.findUser(pool, userId);
        if (!user) throw new AppError('INTERNAL_ERROR');
        return toAdminUser(user);
    },

    async getUser(userId: string): Promise<AdminUserDetails> {
        const user = await adminRepository.findUser(pool, userId);
        if (!user) throw new AppError('NOT_FOUND', 'Không tìm thấy người dùng.');
        const books = await adminRepository.getUserBooks(pool, userId);
        return AdminUserDetailsSchema.parse({
            ...toAdminUser(user),
            books: books.map(toBookSummary),
        });
    },

    async updateUser(
        actor: Auth,
        userId: string,
        body: AdminUpdateUserBody,
    ): Promise<AdminUpdateUserResult> {
        try {
            return await withTransaction(async (db) => {
                const current = await adminRepository.lockUser(db, userId);
                if (!current) throw new AppError('NOT_FOUND', 'Không tìm thấy người dùng.');

                const statusChanged = body.status !== undefined && body.status !== current.status;
                const roleChanged = body.role !== undefined && body.role !== current.role;
                const quotaChanged =
                    body.storageQuotaBytes !== undefined &&
                    body.storageQuotaBytes !== Number(current.storage_quota_bytes);

                if (
                    actor.userId === userId &&
                    ((statusChanged && body.status === 'LOCKED') ||
                        (roleChanged && body.role === 'AUTHOR'))
                ) {
                    throw new AppError('SELF_ACTION');
                }

                const updated =
                    statusChanged || roleChanged || quotaChanged
                        ? await adminRepository.updateUser(db, userId, body)
                        : current;
                const reason = body.reason ?? null;

                if (statusChanged && body.status === 'LOCKED') {
                    await adminRepository.revokeUserSessions(db, userId);
                    await adminRepository.hideUserBooks(db, userId);
                    await adminRepository.insertNotification(db, userId, {
                        type: 'ACCOUNT_LOCKED',
                        title: 'Tài khoản đã bị khoá',
                        body: reason ?? 'Tài khoản của bạn đã bị quản trị viên khoá.',
                    });
                    await adminRepository.insertAuditLog(db, actor.userId, 'LOCK_USER', userId, {
                        from: current.status,
                        to: updated.status,
                        reason,
                    });
                }

                if (statusChanged && body.status === 'ACTIVE') {
                    await adminRepository.restoreUserBooks(db, userId);
                    await adminRepository.insertNotification(db, userId, {
                        type: 'ACCOUNT_UNLOCKED',
                        title: 'Tài khoản đã được mở khoá',
                        body: reason ?? 'Tài khoản của bạn đã được quản trị viên mở khoá.',
                    });
                    await adminRepository.insertAuditLog(db, actor.userId, 'UNLOCK_USER', userId, {
                        from: current.status,
                        to: updated.status,
                        reason,
                    });
                }

                if (roleChanged) {
                    if (body.role === 'AUTHOR') {
                        await adminRepository.revokeUserSessions(db, userId);
                    }
                    await adminRepository.insertAuditLog(db, actor.userId, 'CHANGE_ROLE', userId, {
                        from: current.role,
                        to: updated.role,
                        reason,
                    });
                }

                if (quotaChanged) {
                    await adminRepository.insertAuditLog(db, actor.userId, 'SET_QUOTA', userId, {
                        from: Number(current.storage_quota_bytes),
                        to: Number(updated.storage_quota_bytes),
                        reason,
                    });
                }

                return AdminUpdateUserResultSchema.parse({
                    user: {
                        id: updated.id,
                        status: updated.status,
                        role: updated.role,
                        storageQuotaBytes: Number(updated.storage_quota_bytes),
                    },
                });
            });
        } catch (error) {
            if (isLastAdminError(error)) throw new AppError('LAST_ADMIN');
            throw error;
        }
    },
};

const toAdminUser = (user: AdminUserRow): AdminUser =>
    AdminUserSchema.parse({
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        organization: user.organization,
        bio: user.bio,
        role: user.role,
        status: user.status,
        emailVerified: user.email_verified_at !== null,
        storage: {
            usedBytes: Number(user.storage_used_bytes),
            quotaBytes: Number(user.storage_quota_bytes),
        },
        bookCount: user.book_count,
        lastLoginAt: user.last_login_at?.toISOString() ?? null,
        createdAt: user.created_at.toISOString(),
        updatedAt: user.updated_at.toISOString(),
    });

const toBookSummary = (book: AdminBookRow): BookSummary =>
    BookSummarySchema.parse({
        id: book.id,
        title: book.title,
        coverUrl: null,
        status: book.status,
        visibility: book.visibility,
        takenDown: book.taken_down,
        pageCount: book.page_count,
        updatedAt: book.updated_at.toISOString(),
    });

const toModerationBookSummary = (book: ModerationBookRow) => ({
    id: book.id,
    title: book.title,
    coverUrl: book.cover_url,
    status: book.status,
    visibility: book.visibility,
    takenDown: book.taken_down,
    pageCount: book.page_count,
    updatedAt: book.updated_at.toISOString(),
});

const isLastAdminError = (error: unknown) => {
    const databaseError = error as { code?: string; message?: string };
    return databaseError.code === '23001' && databaseError.message?.includes('LAST_ADMIN');
};

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';
