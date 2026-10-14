import { z } from 'zod';
import {
    BytesSchema,
    HttpUrlSchema,
    IdSchema,
    IsoDateTimeSchema,
    LIMITS,
    PaginationQuerySchema,
    shortText,
    sortQuery,
} from '../common.schema';
import {
    AdminUserSchema,
    BookSummarySchema,
    JobSchema,
    PageSummarySchema,
    UserRefSchema,
} from '../dto.schema';
import {
    AssetTypeSchema,
    AuditActionSchema,
    AuditTargetTypeSchema,
    BookVisibilitySchema,
    JobStatusSchema,
    JobTypeSchema,
    ReportReasonSchema,
    ReportStatusSchema,
    UserRoleSchema,
    UserStatusSchema,
} from '../enums.schema';
import { MarkerScoreSchema } from '../marker.schema';
import { EmailSchema, NewPasswordSchema } from './auth.schema';

// --- Dashboard -----------------------------------------------------------------------------------
export const AdminDashboardSchema = z.object({
    users: z.int().min(0),
    publishedBooks: z.int().min(0),
    storageUsedBytes: BytesSchema,
    failedJobs24h: z.int().min(0),
    openReports: z.int().min(0),
    publishedPerDay: z.array(z.object({ date: z.iso.date(), count: z.int().min(0) })),
    auditActionsToday: z.array(z.object({ action: AuditActionSchema, count: z.int().min(1) })),
});
export type AdminDashboard = z.infer<typeof AdminDashboardSchema>;

// --- Users ------------------------------------------------------------------------
export const AdminUsersQuerySchema = PaginationQuerySchema.extend({
    q: z.string().trim().max(100).optional(),
    role: UserRoleSchema.optional(),
    status: UserStatusSchema.optional(),
    sort: sortQuery(['displayName', 'email', 'createdAt', 'updatedAt', 'storageUsedBytes']).default(
        '-createdAt',
    ),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;

export const AdminCreateUserBodySchema = z.object({
    email: EmailSchema,
    password: NewPasswordSchema,
    displayName: shortText(100),
    role: UserRoleSchema.default('AUTHOR'),
    storageQuotaBytes: z.int().positive().default(LIMITS.defaultQuotaBytes),
});
export type AdminCreateUserBody = z.infer<typeof AdminCreateUserBodySchema>;

export const AdminUserDetailsSchema = AdminUserSchema.extend({
    books: z.array(BookSummarySchema),
});
export type AdminUserDetails = z.infer<typeof AdminUserDetailsSchema>;

/**
 * `PATCH /admin/users/:userId`: all fields optional, but `reason` is required when changing
 * `status` or `role`. Locking signs the user out everywhere and sets their books to PRIVATE.
 */
export const AdminUpdateUserBodySchema = z
    .object({
        status: UserStatusSchema.optional(),
        role: UserRoleSchema.optional(),
        storageQuotaBytes: z.int().positive().optional(),
        reason: z.string().trim().min(1).max(500).optional(),
    })
    .refine(
        (b) => b.status !== undefined || b.role !== undefined || b.storageQuotaBytes !== undefined,
        {
            error: 'Cần gửi ít nhất một trường để sửa',
        },
    )
    .refine((b) => (b.status === undefined && b.role === undefined) || b.reason !== undefined, {
        path: ['reason'],
        error: 'Cần nhập lý do khi khoá tài khoản hoặc đổi vai trò',
    });
export type AdminUpdateUserBody = z.infer<typeof AdminUpdateUserBodySchema>;

export const AdminUpdateUserResultSchema = z.object({
    user: z.object({
        id: IdSchema,
        status: UserStatusSchema,
        role: UserRoleSchema,
        storageQuotaBytes: BytesSchema,
    }),
});
export type AdminUpdateUserResult = z.infer<typeof AdminUpdateUserResultSchema>;
// --- Moderation -------------------------------------------------------------------

export const AdminBooksQuerySchema = PaginationQuerySchema.extend({
    q: z.string().trim().max(100).optional(),
    visibility: BookVisibilitySchema.default('PUBLIC'),
});
export type AdminBooksQuery = z.infer<typeof AdminBooksQuerySchema>;
export const AdminBookItemSchema = BookSummarySchema.extend({
    author: UserRefSchema,
    reportCount: z.int().min(0),
});
export type AdminBookItem = z.infer<typeof AdminBookItemSchema>;
export const ReportItemSchema = z.object({
    id: IdSchema,
    reason: ReportReasonSchema,
    note: z.string().nullable(),
    status: ReportStatusSchema,
    createdAt: IsoDateTimeSchema,
    handledAt: IsoDateTimeSchema.nullable(),
});
export type ReportItem = z.infer<typeof ReportItemSchema>;

export const AdminPageSummarySchema = PageSummarySchema.extend({
    thumbnailUrl: HttpUrlSchema.nullable(),
});

export const AdminBookDetailSchema = z.object({
    book: BookSummarySchema.extend({
        author: UserRefSchema,
        description: z.string().nullable(),
        takenDownReason: z.string().nullable(),
        pages: z.array(AdminPageSummarySchema),
    }),
    reports: z.array(ReportItemSchema),
});
export type AdminBookDetail = z.infer<typeof AdminBookDetailSchema>;

export const TakedownBodySchema = z.object({
    reason: z.string().trim().min(1, { error: 'Cần nhập lý do gỡ sách' }).max(1000),
});
export type TakedownBody = z.infer<typeof TakedownBodySchema>;

export const TakedownResultSchema = z.object({
    book: z.object({ id: IdSchema, visibility: BookVisibilitySchema, takenDown: z.boolean() }),
    resolvedReports: z.int().min(0),
});
export type TakedownResult = z.infer<typeof TakedownResultSchema>;
export const ModerationNoteBodySchema = z.object({
    note: z.string().trim().max(1000).optional(),
});
export type ModerationNoteBody = z.infer<typeof ModerationNoteBodySchema>;
export const DismissReportsResultSchema = z.object({
    dismissedReports: z.int().min(0),
});
export type DismissReportsResult = z.infer<typeof DismissReportsResultSchema>;

// --- Shared library ------------------------------------------------------------------------------

export const LibraryAssetsQuerySchema = PaginationQuerySchema.extend({
    type: AssetTypeSchema.optional(),
    categoryId: IdSchema.optional(),
    q: z.string().trim().max(100).optional(),
});
export type LibraryAssetsQuery = z.infer<typeof LibraryAssetsQuerySchema>;

/** Shared assets must carry a license and the original author (database CHECK). */
export const CreateLibraryAssetBodySchema = z.object({
    assetId: IdSchema,
    name: shortText(150),
    categoryId: IdSchema.nullable().optional(),
    license: shortText(50),
    authorName: shortText(150),
    sourceUrl: HttpUrlSchema.optional(),
    tags: z.array(shortText(30)).max(20).default([]),
});
export type CreateLibraryAssetBody = z.infer<typeof CreateLibraryAssetBodySchema>;

export const UpdateLibraryAssetBodySchema = z
    .object({
        name: shortText(150).optional(),
        categoryId: IdSchema.nullable().optional(),
        license: shortText(50).optional(),
        authorName: shortText(150).optional(),
        sourceUrl: HttpUrlSchema.nullable().optional(),
        tags: z.array(shortText(30)).max(20).optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
        error: 'Cần gửi ít nhất một trường để sửa',
    });
export type UpdateLibraryAssetBody = z.infer<typeof UpdateLibraryAssetBodySchema>;

export const CreateCategoryBodySchema = z.object({
    name: shortText(100),
    parentId: IdSchema.nullable().optional(),
});
export type CreateCategoryBody = z.infer<typeof CreateCategoryBodySchema>;

export const UpdateCategoryBodySchema = z
    .object({
        name: shortText(100).optional(),
        parentId: IdSchema.nullable().optional(),
        sortOrder: z.int().min(-32768).max(32767).optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
        error: 'Cần gửi ít nhất một trường để sửa',
    });
export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBodySchema>;

// --- Bookaria marker set -------------------------------------------------------------------------
/** Adds a pre-built marker to the shared set. */
export const CreateBookariaMarkerBodySchema = z.object({
    number: z.int().positive(),
    imagePublicId: z.string().min(1).max(300),
    mindPublicId: z.string().min(1).max(300),
    seed: z.int(),
    markerScore: MarkerScoreSchema.optional(),
});
export type CreateBookariaMarkerBody = z.infer<typeof CreateBookariaMarkerBodySchema>;

export const UpdateBookariaMarkerBodySchema = z.object({ isActive: z.boolean() });
export type UpdateBookariaMarkerBody = z.infer<typeof UpdateBookariaMarkerBodySchema>;

// --- Jobs and audit ------------------------------------------------------------------------------
export const AdminJobsQuerySchema = PaginationQuerySchema.extend({
    status: JobStatusSchema.optional(),
    type: JobTypeSchema.optional(),
});
export type AdminJobsQuery = z.infer<typeof AdminJobsQuerySchema>;

export const AdminJobSchema = JobSchema.extend({
    attempts: z.int().min(0).max(3),
    createdBy: UserRefSchema.nullable(),
});
export type AdminJob = z.infer<typeof AdminJobSchema>;

export const AuditLogsQuerySchema = PaginationQuerySchema.extend({
    action: AuditActionSchema.optional(),
    actorId: IdSchema.optional(),
    targetType: AuditTargetTypeSchema.optional(),
    targetId: IdSchema.optional(),
});
export type AuditLogsQuery = z.infer<typeof AuditLogsQuerySchema>;
