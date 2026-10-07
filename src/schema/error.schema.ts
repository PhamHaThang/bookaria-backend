import { z } from 'zod';
/**
 * Error codes used in the API responses.
 */
export const ErrorCodeSchema = z.enum([
    'VALIDATION_ERROR',
    'TOKEN_INVALID',
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'INVALID_CREDENTIALS',
    'FORBIDDEN',
    'EMAIL_NOT_VERIFIED',
    'BOOK_TAKEN_DOWN',
    'NOT_FOUND',
    'EMAIL_TAKEN',
    'REVISION_CONFLICT',
    'ASSET_IN_USE',
    'JOB_IN_PROGRESS',
    'BOOK_UNAVAILABLE',
    'FILE_TOO_LARGE',
    'FILE_TYPE_NOT_ALLOWED',
    'QUOTA_EXCEEDED',
    'PUBLISH_BLOCKED',
    'LAST_ADMIN',
    'SELF_ACTION',
    'ACCOUNT_LOCKED',
    'RATE_LIMITED',
    'MARKER_POOL_EXHAUSTED',
    'INTERNAL_ERROR',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * HTTP status codes corresponding to the error codes.
 */
export const HTTP_STATUS: Record<ErrorCode, number> = {
    VALIDATION_ERROR: 400,
    TOKEN_INVALID: 400,
    UNAUTHENTICATED: 401,
    TOKEN_EXPIRED: 401,
    INVALID_CREDENTIALS: 401,
    FORBIDDEN: 403,
    EMAIL_NOT_VERIFIED: 403,
    BOOK_TAKEN_DOWN: 403,
    NOT_FOUND: 404,
    EMAIL_TAKEN: 409,
    REVISION_CONFLICT: 409,
    ASSET_IN_USE: 409,
    JOB_IN_PROGRESS: 409,
    BOOK_UNAVAILABLE: 410,
    FILE_TOO_LARGE: 413,
    FILE_TYPE_NOT_ALLOWED: 422,
    QUOTA_EXCEEDED: 422,
    PUBLISH_BLOCKED: 422,
    LAST_ADMIN: 422,
    SELF_ACTION: 422,
    MARKER_POOL_EXHAUSTED: 422,
    ACCOUNT_LOCKED: 423,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500,
};

/**
 * Error messages corresponding to the error codes.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
    VALIDATION_ERROR: 'Dữ liệu gửi lên không hợp lệ.',
    TOKEN_INVALID: 'Liên kết không đúng, đã hết hạn hoặc đã được dùng.',
    UNAUTHENTICATED: 'Bạn cần đăng nhập để tiếp tục.',
    TOKEN_EXPIRED: 'Phiên đăng nhập đã hết hạn.',
    INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.',
    FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
    EMAIL_NOT_VERIFIED: 'Bạn cần xác nhận email trước khi xuất bản sách.',
    BOOK_TAKEN_DOWN: 'Sách này đã bị gỡ nên không thể xuất bản hoặc mở công khai.',
    NOT_FOUND: 'Không tìm thấy nội dung được yêu cầu.',
    EMAIL_TAKEN: 'Email này đã được đăng ký.',
    REVISION_CONFLICT: 'Trang đã được sửa ở nơi khác.',
    ASSET_IN_USE: 'Tài nguyên đang được dùng trong sách nên chưa xoá được.',
    JOB_IN_PROGRESS: 'Đang có một tác vụ chạy cho sách này, vui lòng đợi.',
    BOOK_UNAVAILABLE: 'Sách này hiện không khả dụng.',
    FILE_TOO_LARGE: 'File vượt quá dung lượng cho phép.',
    FILE_TYPE_NOT_ALLOWED: 'Loại file này không được hỗ trợ.',
    QUOTA_EXCEEDED: 'Bạn đã dùng hết dung lượng lưu trữ.',
    PUBLISH_BLOCKED: 'Sách còn lỗi cần sửa trước khi xuất bản.',
    LAST_ADMIN: 'Không thể khoá hoặc hạ quyền quản trị viên cuối cùng.',
    SELF_ACTION: 'Bạn không thể tự khoá hoặc tự hạ quyền của mình.',
    ACCOUNT_LOCKED: 'Tài khoản đang bị khoá.',
    RATE_LIMITED: 'Bạn thao tác quá nhanh, vui lòng thử lại sau.',
    MARKER_POOL_EXHAUSTED: 'Sách đã dùng hết số marker Bookaria.',
    INTERNAL_ERROR: 'Đã có lỗi xảy ra, vui lòng thử lại sau.',
};

/**
 * Error body schema for API responses.
 */
export const ValidationIssueSchema = z.object({
    path: z.string(),
    message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ApiErrorSchema = z.object({
    error: z.object({
        code: ErrorCodeSchema,
        message: z.string(),
        details: z
            .union([z.array(ValidationIssueSchema), z.record(z.string(), z.unknown())])
            .optional(),
        requestId: z.string(),
    }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Turns a ZodError into an array of ValidationIssue objects, which can be used in API responses.
 */
export function formatZodError(error: z.ZodError): ValidationIssue[] {
    return error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
    }));
}

/**
 * Switches Zod's built-in messages (such as "Invalid URL") to Vietnamese. Messages set explicitly in
 * the schemas are not affected. Call once at start-up, on the server and in the Studio.
 */
export function enableVietnameseMessages(): void {
    z.config(z.locales.vi());
}

/** Build an `ApiError` body for a code, using the default Vietnamese message. */
export function apiError(
    code: ErrorCode,
    requestId: string,
    options: { message?: string; details?: ApiError['error']['details'] } = {},
): ApiError {
    return {
        error: {
            code,
            message: options.message ?? ERROR_MESSAGES[code],
            ...(options.details === undefined ? {} : { details: options.details }),
            requestId,
        },
    };
}
