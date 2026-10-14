import { randomUUID } from 'node:crypto';
import { env } from '../../config';
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
    type AdminJob,
    AdminJobSchema,
    type AdminJobsQuery,
    type AdminUpdateUserBody,
    type AdminUpdateUserResult,
    AdminUpdateUserResultSchema,
    type AdminUser,
    type AdminUserDetails,
    AdminUserDetailsSchema,
    AdminUserSchema,
    type AdminUsersQuery,
    type Asset,
    AssetCategorySchema,
    AssetSchema,
    type AuditLog,
    AuditLogSchema,
    type AuditLogsQuery,
    type BookariaMarker,
    BookariaMarkerSchema,
    type BookSummary,
    BookSummarySchema,
    type CreateBookariaMarkerBody,
    type CreateCategoryBody,
    type CreateLibraryAssetBody,
    type DismissReportsResult,
    DismissReportsResultSchema,
    type LibraryAssetsQuery,
    MARKER_RULES,
    type ModerationItem,
    ModerationItemSchema,
    type ModerationNoteBody,
    type PaginationMeta,
    type PaginationQuery,
    type TakedownBody,
    type TakedownResult,
    TakedownResultSchema,
    type UpdateBookariaMarkerBody,
    type UpdateCategoryBody,
    type UpdateLibraryAssetBody,
} from '../../schema';
import { AppError, buildPaginationMeta, lockedByAdminError, toOffset } from '../../utils';
import { adminRepository } from './admin.repository';
import type {
    AdminBookRow,
    AdminJobRow,
    AdminUserRow,
    AssetCategoryRow,
    AuditLogRow,
    BookariaMarkerRow,
    LibraryAssetRow,
    ModerationBookRow,
} from './admin.types';

export const adminService = {
    async assertAdmin(auth: Auth): Promise<void> {
        const user = await adminRepository.findCurrentAdmin(pool, auth.userId, auth.sessionId);
        if (!user) throw new AppError('UNAUTHENTICATED');
        if (user.status !== 'ACTIVE') throw lockedByAdminError();
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

    async getLibraryAssets(
        query: LibraryAssetsQuery,
    ): Promise<{ rows: Asset[]; meta: PaginationMeta }> {
        const { rows, total } = await adminRepository.getLibraryAssets(
            pool,
            query,
            toOffset(query),
        );
        return {
            rows: rows.map(toLibraryAsset),
            meta: buildPaginationMeta(query, total),
        };
    },

    async createLibraryAsset(actor: Auth, body: CreateLibraryAssetBody): Promise<Asset> {
        const asset = await withTransaction(async (db) => {
            const current = await adminRepository.lockOwnedAsset(db, body.assetId);
            if (!current) throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên đã upload.');
            if (current.status !== 'READY') {
                throw new AppError(
                    'VALIDATION_ERROR',
                    'Chỉ có thể đưa tài nguyên READY vào thư viện chung.',
                );
            }
            if (body.categoryId && !(await adminRepository.findCategory(db, body.categoryId))) {
                throw new AppError('NOT_FOUND', 'Không tìm thấy danh mục.');
            }

            const promoted = await adminRepository.promoteLibraryAsset(db, body.assetId, {
                name: body.name,
                categoryId: body.categoryId ?? null,
                license: body.license,
                authorName: body.authorName,
                sourceUrl: body.sourceUrl ?? null,
                tags: cleanTags(body.tags),
            });
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'CREATE_LIBRARY_ASSET',
                body.assetId,
                {
                    fromOwnerId: current.owner_id,
                    name: promoted.name,
                    categoryId: promoted.category_id,
                    license: promoted.license,
                    authorName: promoted.author_name,
                },
                'ASSET',
            );
            return promoted;
        });
        return toLibraryAsset(asset);
    },

    async updateLibraryAsset(
        actor: Auth,
        assetId: string,
        body: UpdateLibraryAssetBody,
    ): Promise<Asset> {
        const asset = await withTransaction(async (db) => {
            const current = await adminRepository.lockLibraryAsset(db, assetId);
            if (!current) throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên thư viện.');
            if (!current.license || !current.author_name) throw new AppError('INTERNAL_ERROR');
            if (
                body.categoryId &&
                body.categoryId !== current.category_id &&
                !(await adminRepository.findCategory(db, body.categoryId))
            ) {
                throw new AppError('NOT_FOUND', 'Không tìm thấy danh mục.');
            }

            const next = {
                name: body.name ?? current.name,
                categoryId: body.categoryId === undefined ? current.category_id : body.categoryId,
                license: body.license ?? current.license,
                authorName: body.authorName ?? current.author_name,
                sourceUrl: body.sourceUrl === undefined ? current.source_url : body.sourceUrl,
                tags: body.tags === undefined ? current.tags : cleanTags(body.tags),
            };
            if (sameLibraryAsset(current, next)) return current;

            const updated = await adminRepository.updateLibraryAsset(db, assetId, next);
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'UPDATE_LIBRARY_ASSET',
                assetId,
                {
                    before: editableLibraryAsset(current),
                    after: editableLibraryAsset(updated),
                },
                'ASSET',
            );
            return updated;
        });
        return toLibraryAsset(asset);
    },

    async deleteLibraryAsset(actor: Auth, assetId: string): Promise<void> {
        await withTransaction(async (db) => {
            const asset = await adminRepository.lockLibraryAsset(db, assetId);
            if (!asset) throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên thư viện.');
            const usage = await adminRepository.getAssetUsageCounts(db, assetId);
            if (usage.cover_count + usage.page_image_count + usage.page_asset_count > 0) {
                throw new AppError('ASSET_IN_USE', undefined, {
                    covers: usage.cover_count,
                    pageImages: usage.page_image_count,
                    pageAssets: usage.page_asset_count,
                });
            }
            await adminRepository.softDeleteLibraryAsset(db, assetId);
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'DELETE_ASSET',
                assetId,
                { name: asset.name, categoryId: asset.category_id, softDeleted: true },
                'ASSET',
            );
        });
    },

    async createCategory(actor: Auth, body: CreateCategoryBody) {
        const category = await withTransaction(async (db) => {
            await adminRepository.lockCategoryTree(db);
            if (body.parentId && !(await adminRepository.findCategory(db, body.parentId))) {
                throw new AppError('NOT_FOUND', 'Không tìm thấy danh mục cha.');
            }
            const created = await adminRepository.insertCategory(db, {
                name: body.name,
                slug: `${slugify(body.name)}-${randomUUID().slice(0, 8)}`,
                parentId: body.parentId ?? null,
            });
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'MANAGE_CATEGORY',
                created.id,
                { operation: 'CREATE', name: created.name, parentId: created.parent_id },
                'CATEGORY',
            );
            return created;
        });
        return toCategory(category);
    },

    async updateCategory(actor: Auth, categoryId: string, body: UpdateCategoryBody) {
        const category = await withTransaction(async (db) => {
            await adminRepository.lockCategoryTree(db);
            const current = await adminRepository.findCategory(db, categoryId);
            if (!current) throw new AppError('NOT_FOUND', 'Không tìm thấy danh mục.');

            if (body.parentId) {
                if (!(await adminRepository.findCategory(db, body.parentId))) {
                    throw new AppError('NOT_FOUND', 'Không tìm thấy danh mục cha.');
                }
                if (await adminRepository.categoryWouldCycle(db, categoryId, body.parentId)) {
                    throw new AppError('CATEGORY_CYCLE');
                }
            }

            const next = {
                name: body.name ?? current.name,
                parentId: body.parentId === undefined ? current.parent_id : body.parentId,
                sortOrder: body.sortOrder ?? current.sort_order,
            };
            if (
                next.name === current.name &&
                next.parentId === current.parent_id &&
                next.sortOrder === current.sort_order
            ) {
                return current;
            }

            const updated = await adminRepository.updateCategory(db, categoryId, next);
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'MANAGE_CATEGORY',
                categoryId,
                {
                    operation: 'UPDATE',
                    before: toCategory(current),
                    after: toCategory(updated),
                },
                'CATEGORY',
            );
            return updated;
        });
        return toCategory(category);
    },

    async deleteCategory(actor: Auth, categoryId: string): Promise<void> {
        await withTransaction(async (db) => {
            await adminRepository.lockCategoryTree(db);
            const category = await adminRepository.findCategory(db, categoryId);
            if (!category) throw new AppError('NOT_FOUND', 'Không tìm thấy danh mục.');
            if (await adminRepository.categoryHasContent(db, categoryId)) {
                throw new AppError('CATEGORY_NOT_EMPTY');
            }
            await adminRepository.deleteCategory(db, categoryId);
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'MANAGE_CATEGORY',
                categoryId,
                {
                    operation: 'DELETE',
                    name: category.name,
                    parentId: category.parent_id,
                },
                'CATEGORY',
            );
        });
    },

    async getBookariaMarkers(
        query: PaginationQuery,
    ): Promise<{ rows: BookariaMarker[]; meta: PaginationMeta }> {
        const { rows, total } = await adminRepository.getBookariaMarkers(
            pool,
            query,
            toOffset(query),
        );
        return {
            rows: rows.map(toBookariaMarker),
            meta: buildPaginationMeta(query, total),
        };
    },

    async createBookariaMarker(
        actor: Auth,
        body: CreateBookariaMarkerBody,
    ): Promise<BookariaMarker> {
        try {
            const marker = await withTransaction(async (db) => {
                const created = await adminRepository.insertBookariaMarker(db, {
                    ...body,
                    markerScore: body.markerScore ?? null,
                });
                await adminRepository.insertAuditLog(
                    db,
                    actor.userId,
                    'MANAGE_MARKER',
                    created.id,
                    {
                        operation: 'CREATE',
                        number: created.number,
                        seed: created.seed,
                        isActive: created.is_active,
                    },
                    'MARKER',
                );
                return created;
            });
            return toBookariaMarker(marker);
        } catch (error) {
            if (isUniqueViolation(error)) throw new AppError('MARKER_DUPLICATE');
            throw error;
        }
    },

    async updateBookariaMarker(
        actor: Auth,
        markerId: string,
        body: UpdateBookariaMarkerBody,
    ): Promise<BookariaMarker> {
        const marker = await withTransaction(async (db) => {
            const current = await adminRepository.lockBookariaMarker(db, markerId);
            if (!current) throw new AppError('NOT_FOUND', 'Không tìm thấy marker.');
            if (current.is_active === body.isActive) return current;

            const updated = await adminRepository.setBookariaMarkerActive(
                db,
                markerId,
                body.isActive,
            );
            await adminRepository.insertAuditLog(
                db,
                actor.userId,
                'MANAGE_MARKER',
                markerId,
                {
                    operation: 'SET_ACTIVE',
                    number: updated.number,
                    from: current.is_active,
                    to: updated.is_active,
                },
                'MARKER',
            );
            return updated;
        });
        return toBookariaMarker(marker);
    },

    async getJobs(query: AdminJobsQuery): Promise<{ rows: AdminJob[]; meta: PaginationMeta }> {
        const { rows, total } = await adminRepository.getJobs(pool, query, toOffset(query));
        return {
            rows: rows.map(toAdminJob),
            meta: buildPaginationMeta(query, total),
        };
    },

    async retryJob(actor: Auth, jobId: string): Promise<string> {
        try {
            return await withTransaction(async (db) => {
                const job = await adminRepository.lockJob(db, jobId);
                if (!job) throw new AppError('NOT_FOUND', 'Không tìm thấy job.');
                if (job.status === 'QUEUED' || job.status === 'RUNNING') {
                    throw new AppError('JOB_IN_PROGRESS');
                }
                if (job.status !== 'FAILED') {
                    throw new AppError('VALIDATION_ERROR', 'Chỉ có thể chạy lại job FAILED.');
                }
                if (await adminRepository.hasOpenJobForRef(db, job.ref_type, job.ref_id, job.id)) {
                    throw new AppError('JOB_IN_PROGRESS');
                }
                await adminRepository.retryJob(db, jobId);
                await adminRepository.insertAuditLog(
                    db,
                    actor.userId,
                    'RETRY_JOB',
                    jobId,
                    {
                        type: job.type,
                        ref: { type: job.ref_type, id: job.ref_id },
                        reset: ['status', 'progress', 'attempts', 'result', 'error', 'timestamps'],
                    },
                    'JOB',
                );
                return jobId;
            });
        } catch (error) {
            if (isUniqueViolation(error)) throw new AppError('JOB_IN_PROGRESS');
            throw error;
        }
    },

    async getAuditLogs(query: AuditLogsQuery): Promise<{ rows: AuditLog[]; meta: PaginationMeta }> {
        const { rows, total } = await adminRepository.getAuditLogs(pool, query, toOffset(query));
        return {
            rows: rows.map(toAuditLog),
            meta: buildPaginationMeta(query, total),
        };
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
        coverUrl: book.cover_url,
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

const cleanTags = (tags: string[]) => [...new Set(tags.map((tag) => tag.toLowerCase()))];

const editableLibraryAsset = (asset: LibraryAssetRow) => ({
    name: asset.name,
    categoryId: asset.category_id,
    license: asset.license,
    authorName: asset.author_name,
    sourceUrl: asset.source_url,
    tags: asset.tags,
});

const sameLibraryAsset = (
    current: LibraryAssetRow,
    next: {
        name: string;
        categoryId: string | null;
        license: string;
        authorName: string;
        sourceUrl: string | null;
        tags: string[];
    },
) =>
    current.name === next.name &&
    current.category_id === next.categoryId &&
    current.license === next.license &&
    current.author_name === next.authorName &&
    current.source_url === next.sourceUrl &&
    JSON.stringify(current.tags) === JSON.stringify(next.tags);

const toLibraryAsset = (asset: LibraryAssetRow): Asset =>
    AssetSchema.parse({
        id: asset.id,
        type: asset.type,
        url: libraryAssetUrl(asset),
        thumbnailUrl: asset.thumbnail_url,
        meta: asset.meta,
        name: asset.name,
        status: asset.status,
        sizeBytes: Number(asset.size_bytes),
        format: asset.format,
        tags: asset.tags,
        license: asset.license,
        authorName: asset.author_name,
        sourceUrl: asset.source_url,
        scope: 'library',
        categoryId: asset.category_id,
        error: asset.error,
        createdAt: asset.created_at.toISOString(),
    });

function libraryAssetUrl(asset: LibraryAssetRow): string {
    const publicId = asset.optimized_public_id ?? asset.original_public_id;
    if (/^https?:\/\//i.test(publicId)) return publicId;
    if (!env.CLOUDINARY_URL) {
        throw new AppError(
            'INTERNAL_ERROR',
            'Chưa cấu hình CLOUDINARY_URL để dựng URL tài nguyên.',
        );
    }
    const cloudName = new URL(env.CLOUDINARY_URL).hostname;
    const path = publicId.split('/').map(encodeURIComponent).join('/');
    return `https://res.cloudinary.com/${cloudName}/${asset.resource_type}/upload/${path}.${asset.format}`;
}

const toCategory = (category: AssetCategoryRow) =>
    AssetCategorySchema.parse({
        id: category.id,
        name: category.name,
        parentId: category.parent_id,
        sortOrder: category.sort_order,
    });

const toBookariaMarker = (marker: BookariaMarkerRow): BookariaMarker =>
    BookariaMarkerSchema.parse({
        id: marker.id,
        number: marker.number,
        imageUrl: markerImageUrl(marker.image_public_id),
        markerScore: marker.marker_score,
        isActive: marker.is_active,
        validatedAt: marker.validated_at?.toISOString() ?? null,
    });

const toAdminJob = (job: AdminJobRow): AdminJob =>
    AdminJobSchema.parse({
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        ref: { type: job.ref_type, id: job.ref_id },
        result: job.result,
        error: job.error ? { code: 'JOB_FAILED', message: job.error } : null,
        createdAt: job.created_at.toISOString(),
        finishedAt: job.finished_at?.toISOString() ?? null,
        attempts: job.attempts,
        createdBy:
            job.created_by_id && job.created_by_display_name
                ? { id: job.created_by_id, displayName: job.created_by_display_name }
                : null,
    });

const toAuditLog = (log: AuditLogRow): AuditLog =>
    AuditLogSchema.parse({
        id: Number(log.id),
        actor: { id: log.actor_id, displayName: log.actor_display_name },
        action: log.action,
        target: { type: log.target_type, id: log.target_id },
        detail: log.detail,
        createdAt: log.created_at.toISOString(),
    });

function markerImageUrl(publicId: string): string {
    if (/^https?:\/\//i.test(publicId)) return publicId;
    if (!env.CLOUDINARY_URL) {
        throw new AppError('INTERNAL_ERROR', 'Chưa cấu hình CLOUDINARY_URL để dựng URL marker.');
    }
    const cloudName = new URL(env.CLOUDINARY_URL).hostname;
    const path = publicId.split('/').map(encodeURIComponent).join('/');
    return `https://res.cloudinary.com/${cloudName}/image/upload/${path}`;
}

function slugify(name: string): string {
    return (
        name
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replaceAll('đ', 'd')
            .replaceAll('Đ', 'd')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 91) || 'category'
    );
}
