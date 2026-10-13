import { pool, withTransaction } from '../../db';
import { hashPassword } from '../../lib';
import type { Auth } from '../../middlewares';
import {
    type AdminCreateUserBody,
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
    type PaginationMeta,
} from '../../schema';
import { AppError, buildPaginationMeta, lockedByAdminError, toOffset } from '../../utils';
import { adminRepository } from './admin.repository';
import type { AdminBookRow, AdminUserRow } from './admin.types';

export const adminService = {
    async assertAdmin(auth: Auth): Promise<void> {
        const user = await adminRepository.findCurrentAdmin(pool, auth.userId, auth.sessionId);
        if (!user) throw new AppError('UNAUTHENTICATED');
        if (user.status === 'LOCKED') throw lockedByAdminError();
        if (user.role !== 'ADMIN') throw new AppError('FORBIDDEN');
        if (!user.session_active) throw new AppError('UNAUTHENTICATED');
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
                    role: body.role,
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

                const updated = await adminRepository.updateUser(db, userId, body);
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

const isLastAdminError = (error: unknown) => {
    const databaseError = error as { code?: string; message?: string };
    return databaseError.code === '23001' && databaseError.message?.includes('LAST_ADMIN');
};

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';
