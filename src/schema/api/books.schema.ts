import { z } from 'zod';
import {
    HttpUrlSchema,
    IdSchema,
    IsoDateTimeSchema,
    LanguageSchema,
    PaginationQuerySchema,
    shortText,
    sortQuery,
} from '../common.schema';
import { BookSummarySchema } from '../dto.schema';
import {
    BookStatusSchema,
    BookVisibilitySchema,
    DeviceTypeSchema,
    PageFormatSchema,
} from '../enums.schema';

// --- Listing -----------------------------------------------------------------------------------------------------------------------------------------

export const BookSortSchema = sortQuery(['updatedAt', 'createdAt', 'title']);

/** `GET /books?q=&status=&sort=-updatedAt&page=&limit=` */
export const ListBooksQuerySchema = PaginationQuerySchema.extend({
    q: z.string().trim().max(100).optional(),
    status: BookStatusSchema.optional(),
    sort: BookSortSchema.default('-updatedAt'),
});
export type ListBooksQuery = z.infer<typeof ListBooksQuerySchema>;

export const TrashBookItemSchema = BookSummarySchema.extend({
    deletedAt: IsoDateTimeSchema,
});
// --- Create and Update -------------------------------------------------------------------------------------------------------------------------------
export const CreateBookSourceSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('BLANK'),
    }),
    z.object({
        type: z.literal('TEMPLATE'),
        templateId: IdSchema,
    }),
]);
export type CreateBookSource = z.infer<typeof CreateBookSourceSchema>;

const AgeSchema = z.int().min(0).max(150);

const checkAges = (b: { ageMin?: number | null | undefined; ageMax?: number | null | undefined }) =>
    b.ageMin == null || b.ageMax == null || b.ageMin <= b.ageMax;

/** `POST /books`. A CUSTOM page format needs `pageAspect`. */
export const CreateBookBodySchema = z
    .object({
        title: shortText(200),
        description: z.string().trim().max(2000).optional(),
        ageMin: AgeSchema.optional(),
        ageMax: AgeSchema.optional(),
        language: LanguageSchema.default('vi'),
        topic: z.string().trim().max(50).optional(),
        pageFormat: PageFormatSchema.default('A4'),
        /** Height divided by width. Required for CUSTOM, ignored otherwise. */
        pageAspect: z.number().min(0.2).max(5).optional(),
        source: CreateBookSourceSchema.default({ type: 'BLANK' }),
    })
    .refine((b) => b.pageFormat !== 'CUSTOM' || b.pageAspect !== undefined, {
        path: ['pageAspect'],
        error: 'Khổ tuỳ chỉnh cần nhập tỉ lệ cao/rộng',
    })
    .refine(checkAges, {
        path: ['ageMax'],
        error: 'Độ tuổi tối đa phải lớn hơn hoặc bằng độ tuổi tối thiểu',
    });
export type CreateBookBody = z.infer<typeof CreateBookBodySchema>;

export const CreateBookResultSchema = z.object({
    book: BookSummarySchema.pick({
        id: true,
        title: true,
        visibility: true,
        status: true,
        pageCount: true,
    }),
});
export type CreateBookResult = z.infer<typeof CreateBookResultSchema>;

/** `PATCH /books/:bookId`. The slug cannot be changed. */
export const UpdateBookBodySchema = z
    .object({
        title: shortText(200).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        ageMin: AgeSchema.nullable().optional(),
        ageMax: AgeSchema.nullable().optional(),
        language: LanguageSchema.optional(),
        topic: z.string().trim().max(50).nullable().optional(),
        pageFormat: PageFormatSchema.optional(),
        pageAspect: z.number().min(0.2).max(5).optional(),
        coverAssetId: IdSchema.nullable().optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
        error: 'Cần gửi ít nhất một trường để sửa',
    })
    .refine(checkAges, {
        path: ['ageMax'],
        error: 'Độ tuổi tối đa phải lớn hơn hoặc bằng độ tuổi tối thiểu',
    });
export type UpdateBookBody = z.infer<typeof UpdateBookBodySchema>;

export const UpdateVisibilityBodySchema = z.object({
    visibility: BookVisibilitySchema,
});
// --- Templates and statistics --------------------------------------------------------------------
/** `GET /templates` */
export const TemplateSummarySchema = z.object({
    id: IdSchema,
    title: z.string(),
    description: z.string().nullable(),
    thumbnailUrl: HttpUrlSchema.nullable(),
    pageCount: z.int().min(0),
});
export const StatsRangeSchema = z.enum(['7d', '30d', '90d']);
export const StatsQuerySchema = z.object({ range: StatsRangeSchema.default('30d') });
export type StatsQuery = z.infer<typeof StatsQuerySchema>;

/** `GET /books/:bookId/stats`: anonymous counters only; no personal data is collected. */
export const BookStatsSchema = z.object({
    range: StatsRangeSchema,
    totals: z.object({
        opens: z.int().min(0),
        sessions: z.int().min(0),
        taps: z.int().min(0),
        scanTimeouts: z.int().min(0),
    }),
    opensByDay: z.array(z.object({ date: z.iso.date(), opens: z.int().min(0) })),
    byPage: z.array(
        z.object({
            pageId: IdSchema,
            pageNumber: z.int().min(1),
            title: z.string().nullable(),
            found: z.int().min(0),
            taps: z.int().min(0),
            scanTimeouts: z.int().min(0),
        }),
    ),
    byDevice: z.array(z.object({ type: DeviceTypeSchema, os: z.string(), count: z.int().min(0) })),
});

export type BookStats = z.infer<typeof BookStatsSchema>;
