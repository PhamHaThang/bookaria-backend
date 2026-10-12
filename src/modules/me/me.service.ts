import { pool, withTransaction } from '../../db';
import { hashPassword, sendMailSafely, verifyPassword } from '../../lib';
import type { Auth } from '../../middlewares';
import {
    type ChangePasswordBody,
    type MarkNotificationsReadBody,
    type Me,
    MeSchema,
    type MeUpdateBody,
    type Notification,
    NotificationSchema,
    type NotificationsQuery,
    type PaginationMeta,
} from '../../schema';
import { AppError, fieldError, lockedByAdminError, temporarilyLockedError } from '../../utils';
import { LOCK_MINUTES, MAX_FAILED_LOGINS } from '../auth/auth.constants';
import { passwordChangedMail } from '../auth/auth.emails';
import { authRepository } from '../auth/auth.repository';
import { meRepository } from './me.repository';
import type { MeRow } from './me.types';

export const meService = {
    async getMe(userId: string): Promise<Me> {
        const user = await meRepository.findMe(pool, userId);
        if (!user) throw new AppError('UNAUTHENTICATED');
        return toMe(user);
    },
    async updateMe(userId: string, body: MeUpdateBody): Promise<Me> {
        const changes: Record<string, string | null> = {};
        if (body.displayName !== undefined) changes.display_name = body.displayName;
        if (body.organization !== undefined) changes.organization = blankToNull(body.organization);
        if (body.bio !== undefined) changes.bio = blankToNull(body.bio);
        if (body.avatarAssetId === null) changes.avatar_url = null;
        if (typeof body.avatarAssetId === 'string') {
            throw fieldError(
                'avatarAssetId',
                'Chưa hỗ trợ đặt ảnh đại diện từ tài nguyên đã tải lên.',
            );
        }
        const user = await meRepository.updateMe(pool, userId, changes);
        if (!user) throw new AppError('UNAUTHENTICATED');
        return toMe(user);
    },
    async changePassword(auth: Auth, body: ChangePasswordBody): Promise<void> {
        const user = await authRepository.findUserById(pool, auth.userId);
        if (!user || !(await authRepository.isSessionActive(pool, auth.userId, auth.sessionId))) {
            throw new AppError('UNAUTHENTICATED');
        }
        if (user.status === 'LOCKED') throw lockedByAdminError();
        if (user.locked_until && user.locked_until > new Date()) {
            throw temporarilyLockedError(user.locked_until);
        }

        // Tài khoản Google chưa có mật khẩu thì không cần mật khẩu hiện tại (đây là đặt mật khẩu lần đầu).
        if (user.password_hash) {
            if (!body.currentPassword) {
                throw fieldError('currentPassword', 'Vui lòng nhập mật khẩu hiện tại.');
            }
            if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
                const result = await authRepository.recordFailedLogin(
                    pool,
                    user.id,
                    MAX_FAILED_LOGINS,
                    LOCK_MINUTES,
                );
                if (result.locked_until) throw temporarilyLockedError(result.locked_until);
                throw fieldError('currentPassword', 'Mật khẩu hiện tại không đúng.');
            }
        }

        const passwordHash = await hashPassword(body.newPassword);
        await withTransaction(async (db) => {
            await authRepository.updateUserPassword(db, user.id, passwordHash);
            await authRepository.revokeAllAuthSessionsForUserExcept(db, user.id, auth.sessionId);
            await authRepository.cancelUnusedAuthTokens(db, user.id, 'RESET_PASSWORD');
        });
        await sendMailSafely(passwordChangedMail(user.email, user.display_name));
    },
    async getNotifications(
        userId: string,
        query: NotificationsQuery,
    ): Promise<{ data: Notification[]; meta: PaginationMeta }> {
        const { rows, total } = await meRepository.getNotifications(pool, userId, {
            unreadOnly: query.unread === true,
            limit: query.limit,
            offset: (query.page - 1) * query.limit,
        });
        const data = rows.map((n) =>
            NotificationSchema.parse({
                id: n.id,
                type: n.type,
                title: n.title,
                body: n.body,
                link: n.link,
                readAt: n.read_at?.toISOString() ?? null,
                createdAt: n.created_at.toISOString(),
            }),
        );
        return {
            data,
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.ceil(total / query.limit),
            },
        };
    },
    async markNotificationsAsRead(userId: string, body: MarkNotificationsReadBody): Promise<void> {
        await meRepository.markNotificationsAsRead(
            pool,
            userId,
            'ids' in body ? body.ids : undefined,
        );
    },
};
// --- Helpers ---------------------------------------------------------------------

const toMe = (u: MeRow): Me =>
    MeSchema.parse({
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        organization: u.organization,
        bio: u.bio,
        role: u.role,
        emailVerified: u.email_verified_at !== null,
        storage: {
            usedBytes: Number(u.storage_used_bytes),
            quotaBytes: Number(u.storage_quota_bytes),
        },
        createdAt: u.created_at.toISOString(),
    });
const blankToNull = (value: string | null) => (value === null || value === '' ? null : value);
