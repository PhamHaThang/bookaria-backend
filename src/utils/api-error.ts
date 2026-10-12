import { ZodError } from 'zod';
import { ERROR_MESSAGES, type ErrorCode, HTTP_STATUS } from '../schema';

/**
 * Lỗi nghiệp vụ. Không truyền `message` thì dùng thông báo mặc định của mã lỗi (`ERROR_MESSAGES`),
 * chỉ truyền khi cần câu riêng cho tình huống cụ thể.
 */
export class AppError extends Error {
    public readonly status: number;
    constructor(
        public readonly code: ErrorCode,
        message?: string,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message ?? ERROR_MESSAGES[code]);
        this.status = HTTP_STATUS[code];
        Error.captureStackTrace(this, this.constructor);
    }
}

export const fieldError = (path: string, message: string) =>
    new ZodError([{ code: 'custom', path: [path], message }]);

/** Tài khoản bị quản trị viên khoá: người dùng không tự mở lại được. */
export const lockedByAdminError = () =>
    new AppError('ACCOUNT_LOCKED', 'Tài khoản đã bị khoá, vui lòng liên hệ quản trị viên.', {
        byAdmin: true,
    });

/** Tài khoản tạm khoá do nhập sai mật khẩu nhiều lần, tự mở lại sau `until`. */
export const temporarilyLockedError = (until: Date) =>
    new AppError(
        'ACCOUNT_LOCKED',
        'Tài khoản tạm thời bị khoá do nhập sai mật khẩu nhiều lần. Vui lòng thử lại sau.',
        { lockedUntil: until.toISOString() },
    );
