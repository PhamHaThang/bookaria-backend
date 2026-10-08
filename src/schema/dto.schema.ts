import { z } from 'zod';
import { AssetMetaSchema, AssetRefSchema } from './asset.schema';
import {
    BytesSchema,
    HttpUrlSchema,
    IdSchema,
    IsoDateTimeSchema,
    LanguageSchema,
    SlugSchema,
} from './common.schema';
import {
    AssetStatusSchema,
    AuditActionSchema,
    AuditTargetTypeSchema,
    BookStatusSchema,
    BookVisibilitySchema,
    JobRefTypeSchema,
    JobStatusSchema,
    JobTypeSchema,
    MarkerModeSchema,
    NotificationTypeSchema,
    PageFormatSchema,
    ReportReasonSchema,
    UserRoleSchema,
    UserStatusSchema,
} from './enums.schema';
import {
    BookariaMarkerPlacementSchema,
    MarkerReportSchema,
    MarkerScoreSchema,
    MarkerWarningSchema,
} from './marker.schema';
import { PageSettingsSchema, SceneSchema } from './scene.schema';

export const UserRefSchema = z.object({
    id: z.string(),
    displayName: z.string(),
});
export type UserRef = z.infer<typeof UserRefSchema>;

// --- Users ---------------------------------------------------------------------------------------
export const StorageUsageSchema = z.object({
    usedBytes: BytesSchema,
    quotaBytes: BytesSchema,
});
export type StorageUsage = z.infer<typeof StorageUsageSchema>;

export const MeSchema = z.object({
    id: IdSchema,
    email: z.email(),
    displayName: z.string(),
    avatarUrl: HttpUrlSchema.nullable(),
    organization: z.string().nullable(),
    bio: z.string().nullable(),
    role: UserRoleSchema,
    emailVerified: z.boolean(),
    storage: StorageUsageSchema,
    createdAt: IsoDateTimeSchema,
});
export type Me = z.infer<typeof MeSchema>;

export const AdminUserSchema = MeSchema.extend({
    status: UserStatusSchema,
    bookCount: z.int().min(0),
    lastLoginAt: IsoDateTimeSchema.nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

// --- Books and pages -----------------------------------------------------------------------------

export const BookSummarySchema = z.object({
    id: IdSchema,
    title: z.string(),
    coverUrl: HttpUrlSchema.nullable(),
    status: BookStatusSchema,
    visibility: BookVisibilitySchema,
    takenDown: z.boolean(),
    pageCount: z.int().min(0),
    updatedAt: IsoDateTimeSchema,
});
export type BookSummary = z.infer<typeof BookSummarySchema>;

export const PageSummarySchema = z.object({
    id: IdSchema,
    orderIndex: z.int().min(0),
    title: z.string().nullable(),
    thumbnailUrl: HttpUrlSchema,
    markerMode: MarkerModeSchema,
    markerNumber: z.int().positive().nullable(),
    markerScore: MarkerScoreSchema.nullable(),
    markerWarnings: z.array(MarkerWarningSchema),
    objectCount: z.int().min(0),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

export const CurrentVersionRefSchema = z.object({
    versionNo: z.int().positive(),
    publishedAt: IsoDateTimeSchema,
});
export const BookDetailSchema = BookSummarySchema.extend({
    description: z.string().nullable(),
    ageMin: z.int().min(0).nullable(),
    ageMax: z.int().min(0).nullable(),
    language: LanguageSchema,
    topic: z.string().nullable(),
    pageFormat: PageFormatSchema,
    /** Height divided by width (A4 = 1.4142). */
    pageAspect: z.number().positive(),
    slug: SlugSchema.nullable(),
    currentVersion: CurrentVersionRefSchema.nullable(),
    pages: z.array(PageSummarySchema),
});
export type BookDetail = z.infer<typeof BookDetailSchema>;

export const PageSchema = PageSummarySchema.extend({
    bookId: IdSchema,
    image: z.object({
        url: HttpUrlSchema,
        width: z.int().positive(),
        height: z.int().positive(),
    }),
    markerReport: MarkerReportSchema.nullable(),
    bookariaMarker: BookariaMarkerPlacementSchema.nullable(),
    settings: PageSettingsSchema,
    scene: SceneSchema,
    revision: z.int().min(0),
    assets: z.record(IdSchema, AssetRefSchema),
    updatedAt: IsoDateTimeSchema,
});
export type Page = z.infer<typeof PageSchema>;

// --- Assets --------------------------------------------------------------------------------------

export const AssetScopeSchema = z.enum(['mine', 'library']);
export type AssetScope = z.infer<typeof AssetScopeSchema>;

export const AssetSchema = AssetRefSchema.extend({
    id: IdSchema,
    name: z.string(),
    status: AssetStatusSchema,
    sizeBytes: z.int().positive(),
    format: z.string(),
    tags: z.array(z.string()),
    license: z.string().nullable(),
    authorName: z.string().nullable(),
    sourceUrl: HttpUrlSchema.nullable(),
    scope: AssetScopeSchema,
    categoryId: IdSchema.nullable(),
    /** When processing failed (status FAILED). */
    error: z.string().nullable().optional(),
    createdAt: IsoDateTimeSchema,
});
export type Asset = z.infer<typeof AssetSchema>;

export const AssetCategorySchema = z.object({
    id: IdSchema,
    name: z.string(),
    parentId: IdSchema.nullable(),
    sortOrder: z.int(),
});
export type AssetCategory = z.infer<typeof AssetCategorySchema>;

// --- Jobs, versions, notifications ---------------------------------------------------------------
export const JobSchema = z.object({
    id: IdSchema,
    type: JobTypeSchema,
    status: JobStatusSchema,
    progress: z.int().min(0).max(100),
    ref: z.object({ type: JobRefTypeSchema, id: IdSchema }),
    /** Per type, see `JobResults`. */
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    createdAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const JobResultsSchema = {
    PUBLISH_BOOK: z.object({
        versionNo: z.int().positive(),
        slug: SlugSchema,
        url: HttpUrlSchema,
    }),
    EXPORT_PDF: z.object({
        url: HttpUrlSchema,
        kind: z.enum(['PRINT', 'MARKER_SHEET']),
    }),
    OPTIMIZE_ASSET: z.object({ assetId: IdSchema, meta: AssetMetaSchema }),
    SCORE_MARKER: z.object({ pageId: IdSchema, score: MarkerScoreSchema }),
    BUILD_PREVIEW: z.object({ token: z.string(), url: HttpUrlSchema }),
} as const;
export const VersionSchema = z.object({
    id: IdSchema,
    versionNo: z.int().positive(),
    pageCount: z.int().min(0),
    arPageCount: z.int().min(0),
    totalBytes: BytesSchema,
    publishedAt: IsoDateTimeSchema,
    publishedBy: UserRefSchema.nullable(),
});
export type Version = z.infer<typeof VersionSchema>;

export const NotificationSchema = z.object({
    id: IdSchema,
    type: NotificationTypeSchema,
    title: z.string(),
    body: z.string().nullable(),
    link: z.string().nullable(),
    readAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

// --- Public (Viewer and discovery pages) ---------------------------------------------------------
export const PublicBookSchema = z.object({
    slug: SlugSchema,
    title: z.string(),
    description: z.string().nullable(),
    author: UserRefSchema,
    coverUrl: HttpUrlSchema.nullable(),
    language: LanguageSchema,
    ageMin: z.int().min(0).max(18).nullable(),
    ageMax: z.int().min(0).max(18).nullable(),
    version: z.object({
        id: IdSchema,
        versionNo: z.int().positive(),
        publishedAt: IsoDateTimeSchema,
    }),
    manifestUrl: HttpUrlSchema,
    pageCount: z.int().min(0),
    arPageCount: z.int().min(0),
    downloadBytes: BytesSchema,
    printPdfUrl: HttpUrlSchema.nullable(),
});
export type PublicBook = z.infer<typeof PublicBookSchema>;

// --- Admin ---------------------------------------------------------------------------------------

export const ModerationItemSchema = z.object({
    book: z.object({ id: IdSchema, title: z.string(), author: UserRefSchema }),
    reportCount: z.int().min(1),
    reasons: z.array(ReportReasonSchema),
    lastReportedAt: IsoDateTimeSchema,
});
export type ModerationItem = z.infer<typeof ModerationItemSchema>;

export const AuditLogSchema = z.object({
    id: z.int(),
    actor: UserRefSchema,
    action: AuditActionSchema,
    target: z.object({ type: AuditTargetTypeSchema, id: IdSchema }),
    detail: z.record(z.string(), z.unknown()).nullable(),
    createdAt: IsoDateTimeSchema,
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

export const BookariaMarkerSchema = z.object({
    id: IdSchema,
    number: z.int().positive(),
    imageUrl: HttpUrlSchema,
    markerScore: MarkerScoreSchema.nullable(),
    isActive: z.boolean(),
    validatedAt: IsoDateTimeSchema.nullable(),
});
export type BookariaMarker = z.infer<typeof BookariaMarkerSchema>;
