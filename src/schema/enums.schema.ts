import { z } from 'zod';

/**
 * Enum schemas and types for the database.
 */
export const UserRoleSchema = z.enum(['AUTHOR', 'ADMIN']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(['ACTIVE', 'LOCKED']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const AuthTokenTypeSchema = z.enum(['VERIFY_EMAIL', 'RESET_PASSWORD']);
export type AuthTokenType = z.infer<typeof AuthTokenTypeSchema>;

export const PageFormatSchema = z.enum(['A4', 'A5', 'SQUARE', 'CUSTOM']);
export type PageFormat = z.infer<typeof PageFormatSchema>;

export const BookVisibilitySchema = z.enum(['PUBLIC', 'PRIVATE', 'UNLISTED']);
export type BookVisibility = z.infer<typeof BookVisibilitySchema>;

export const BookStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'CHANGED']);
export type BookStatus = z.infer<typeof BookStatusSchema>;

export const MarkerModeSchema = z.enum(['BOOKARIA_MARKER', 'CUSTOM_MARKER', 'NONE']);
export type MarkerMode = z.infer<typeof MarkerModeSchema>;

export const AssetTypeSchema = z.enum(['MODEL', 'IMAGE', 'AUDIO', 'VIDEO']);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const AssetStatusSchema = z.enum(['PROCESSING', 'READY', 'FAILED']);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

export const JobTypeSchema = z.enum([
    'SCORE_MARKER',
    'OPTIMIZE_ASSET',
    'BUILD_PREVIEW',
    'EXPORT_PDF',
    'PUBLISH_BOOK',
]);
export type JobType = z.infer<typeof JobTypeSchema>;

export const JobStatusSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobRefTypeSchema = z.enum(['BOOK', 'PAGE', 'ASSET']);
export type JobRefType = z.infer<typeof JobRefTypeSchema>;

export const ViewEventTypeSchema = z.enum(['OPEN', 'PAGE_FOUND', 'TAP', 'SCAN_TIMEOUT']);
export type ViewEventType = z.infer<typeof ViewEventTypeSchema>;

export const ReportReasonSchema = z.enum(['INAPPROPRIATE', 'COPYRIGHT', 'OTHER']);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

export const ReportStatusSchema = z.enum(['OPEN', 'DISMISSED', 'ACTIONED']);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

// Not database enums (columns are varchar), but the values are fixed in the design.

/** Purpose of an upload signature */
export const UploadPurposeSchema = z.enum(['ASSET', 'PAGE_IMAGE', 'PDF', 'AVATAR', 'MARKER_MIND']);
export type UploadPurpose = z.infer<typeof UploadPurposeSchema>;

/** `notifications.type`; these are the values the backend emits. */
export const NotificationTypeSchema = z.enum([
    'JOB_SUCCEEDED',
    'JOB_FAILED',
    'BOOK_TAKEN_DOWN',
    'BOOK_REINSTATED',
    'ACCOUNT_LOCKED',
    'ACCOUNT_UNLOCKED',
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/** `audit_logs.action` is varchar(50). */
export const AuditActionSchema = z.enum([
    'LOCK_USER',
    'UNLOCK_USER',
    'CHANGE_ROLE',
    'SET_QUOTA',
    'TAKE_DOWN_BOOK',
    'REINSTATE_BOOK',
    'RESOLVE_REPORT',
    'DISMISS_REPORT',
    'CREATE_LIBRARY_ASSET',
    'UPDATE_LIBRARY_ASSET',
    'DELETE_ASSET',
    'MANAGE_CATEGORY',
    'MANAGE_MARKER',
    'RETRY_JOB',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/** `audit_logs.target_type`. */
export const AuditTargetTypeSchema = z.enum([
    'USER',
    'BOOK',
    'ASSET',
    'REPORT',
    'JOB',
    'CATEGORY',
    'MARKER',
]);
export type AuditTargetType = z.infer<typeof AuditTargetTypeSchema>;

export const DeviceTypeSchema = z.enum(['mobile', 'tablet', 'desktop']);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

/** Environment lighting preset in page settings. */
export const LightingPresetSchema = z.enum(['neutral', 'warm', 'cool']);
export type LightingPreset = z.infer<typeof LightingPresetSchema>;
