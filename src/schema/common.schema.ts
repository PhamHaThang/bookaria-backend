import { z } from 'zod';

/**
 * Building blocks shared by every schema file.
 */

/** Database id (uuid). Also accepts the nil uuid used by seed data. */
export const IdSchema = z.uuid();

/** ISO 8601 timestamp in UTC, e.g. `2026-10-04T07:30:00Z`. */
export const IsoDateTimeSchema = z.iso.datetime();

/** Only http(s) links: never allow `javascript:` or `data:` URLs. */
export const HttpUrlSchema = z.httpUrl();

/** Id of an object or rule inside a scene (not a database id) */
export const SceneIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,50}$/, {
    error: 'Mã chỉ gồm chữ, số, gạch dưới hoặc gạch ngang (tối đa 50 ký tự)',
});

/** Public Slug */
export const SlugSchema = z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** `vi`, `en`, `en-US`. */
export const LanguageSchema = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/);

/** A 3D vector `[x, y, z]`. `z.number()` already rejects NaN and Infinity. */
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** Non-negative byte count. Quotas and sizes stay far below 2^53, so plain numbers are safe. */
export const BytesSchema = z.int().nonnegative();

/** Non-empty trimmed text with a max length, used for user-facing names. */
export const shortText = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// Responses and pagination
// ---------------------------------------------------------------------------
export const PaginationMetaSchema = z.object({
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export const PaginationQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const dataResponse = <T extends z.ZodType>(data: T) => z.object({ data });

export const pagedResponse = <T extends z.ZodType>(item: T) =>
    z.object({ data: z.array(item), meta: PaginationMetaSchema });

/** `GET /health` */
export const HealthDataSchema = z.object({
    status: z.literal('OK'),
    environment: z.enum(['development', 'production', 'test']),
    timestamp: z.string(),
});
export const HealthResponseSchema = dataResponse(HealthDataSchema);
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** `field` (ascending) or `-field` (descending). */
export type SortValue<T extends string> = T | `-${T}`;

/**
 * Query helper for `?sort=field` or `?sort=-field` query parameter.
 */
export const sortQuery = <const T extends readonly [string, ...string[]]>(fields: T) =>
    z.enum(
        fields.flatMap((f) => [f, `-${f}`]) as unknown as [
            SortValue<T[number]>,
            ...SortValue<T[number]>[],
        ],
    );

/**
 * Limits that appear in the API, in bytes. Used for file uploads and other size limits.
 */
export const MB = 1024 * 1024;

export const LIMITS = {
    /** Default quota in bytes. */
    defaultQuotaBytes: 500 * MB,
    /** Report note length. */
    reportNoteChars: 1000,
    /** Maximum pages when creating a book from a PDF. */
    pdfMaxPageCount: 60,
    /** Minimum and maximum password length. */
    passwordMinLength: 8,
    passwordMaxLength: 72,
} as const;
