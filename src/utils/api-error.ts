import { type ErrorCode, HTTP_STATUS } from '../schema';

export class AppError extends Error {
    public readonly status: number;
    constructor(
        public readonly code: ErrorCode,
        message?: string,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.status = HTTP_STATUS[code];
        Error.captureStackTrace(this, this.constructor);
    }
}
