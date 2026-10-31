import { z } from 'zod';
import {
    BytesSchema,
    HttpUrlSchema,
    IdSchema,
    IsoDateTimeSchema,
    SceneIdSchema,
} from '../common.schema';
import { VersionSchema } from '../dto.schema';
import { BookVisibilitySchema } from '../enums.schema';

// --- Publish check ----------------------------------------------------------------

/** Problems that block publishing. `PAGE_NOT_SCORED` and `PAGE_LOW_SCORE` only apply to custom-marker pages. */
export const PublishErrorCodeSchema = z.enum([
    'PAGE_NO_IMAGE',
    'PAGE_NOT_SCORED',
    'PAGE_LOW_SCORE',
    'ASSET_NOT_READY',
    'ASSET_FAILED',
    'INTERACTION_INVALID',
    'NO_AR_PAGE',
    'EMAIL_NOT_VERIFIED',
    'BOOK_TAKEN_DOWN',
]);
export type PublishErrorCode = z.infer<typeof PublishErrorCodeSchema>;

/** Problems the author can accept (`acceptWarnings`). */
export const PublishWarningCodeSchema = z.enum([
    'PAGE_SIMILAR',
    'PAGE_HEAVY',
    'TOO_MANY_OBJECTS',
    'OBJECT_OFF_PAGE',
    'LARGE_DOWNLOAD',
]);
export type PublishWarningCode = z.infer<typeof PublishWarningCodeSchema>;

/** Where the problem is, so the Studio can jump straight to it. */
const issueLocationSchema = {
    message: z.string(),
    pageId: IdSchema.optional(),
    interactionId: SceneIdSchema.optional(),
    objectId: SceneIdSchema.optional(),
    assetId: IdSchema.optional(),
    /** For PAGE_SIMILAR: the page that looks the same. */
    otherPageId: IdSchema.optional(),
};

export const PublishErrorSchema = z.object({
    code: PublishErrorCodeSchema,
    ...issueLocationSchema,
});
export type PublishError = z.infer<typeof PublishErrorSchema>;

export const PublishWarningSchema = z.object({
    code: PublishWarningCodeSchema,
    ...issueLocationSchema,
});
export type PublishWarning = z.infer<typeof PublishWarningSchema>;

export const PublishCheckSchema = z.object({
    canPublish: z.boolean(),
    hasChanges: z.boolean().optional(),
    summary: z.object({
        pageCount: z.int().min(0),
        arPageCount: z.int().min(0),
        downloadBytes: BytesSchema,
    }),
    errors: z.array(PublishErrorSchema),
    warnings: z.array(PublishWarningSchema),
});
export type PublishCheck = z.infer<typeof PublishCheckSchema>;

/** `details` of the PUBLISH_BLOCKED error: the same lists as `publish-check`. */
export const PublishBlockedDetailsSchema = z.object({
    errors: z.array(PublishErrorSchema),
    warnings: z.array(PublishWarningSchema),
});

// --- Publish, preview, share ---------------------------------------------------------------------

/** `POST /books/:bookId/publish` (202). Warnings left and `acceptWarnings` false => PUBLISH_BLOCKED. */
export const PublishBodySchema = z.object({
    visibility: BookVisibilitySchema,
    acceptWarnings: z.boolean().default(false),
});
export type PublishBody = z.infer<typeof PublishBodySchema>;

/** Newest first. The cursor is the last version number from the previous batch. */
export const ListBookVersionsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(5),
    before: z.coerce.number().int().positive().optional(),
});
export type ListBookVersionsQuery = z.infer<typeof ListBookVersionsQuerySchema>;
export const VersionPageSchema = z.object({
    items: z.array(VersionSchema).max(50),
    nextCursor: z.int().positive().nullable(),
});

export const JobStartedSchema = z.object({ jobId: IdSchema });

/** `POST /books/:bookId/previews` (202): enqueue a 24-hour preview of a book or page. */
export const CreatePreviewBodySchema = z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('BOOK') }),
    z.object({ scope: z.literal('PAGE'), pageId: IdSchema }),
]);

export const PreviewLinkSchema = z.object({
    token: z.string().max(32),
    url: HttpUrlSchema,
    scope: z.enum(['BOOK', 'PAGE']),
    expiresAt: IsoDateTimeSchema,
});

/** `GET /books/:bookId/share`: only for published books. */
export const ShareInfoSchema = z.object({
    url: HttpUrlSchema,
    qrPngUrl: HttpUrlSchema,
    qrSvgUrl: HttpUrlSchema,
    /** `<iframe ...>` snippet for websites. */
    embedHtml: z.string(),
});

/**
 * `POST /books/:bookId/print-pdf` (202):
 * - `PRINT`: pages with QR and Bookaria markers placed, ready to print.
 * - `MARKER_SHEET`: only the markers at real size, to stick on a book that is already printed.
 */
export const PrintQrPlacementSchema = z.object({
    pageId: IdSchema.nullable(),
    xMm: z.number().min(0).max(1000),
    yMm: z.number().min(0).max(5000),
    sizeMm: z.number().min(30).max(60),
});
export const PrintLayoutSchema = z.object({
    coverUrl: HttpUrlSchema.nullable().default(null),
    versionId: IdSchema,
    versionNo: z.int().positive(),
    title: z.string(),
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
    pages: z.array(
        z.object({
            pageId: IdSchema,
            title: z.string().nullable(),
            imageUrl: HttpUrlSchema,
            markerMode: z.enum(['NONE', 'CUSTOM_MARKER', 'BOOKARIA_MARKER']),
            marker: z
                .object({
                    number: z.int().positive(),
                    imageUrl: HttpUrlSchema,
                    xMm: z.number(),
                    yMm: z.number(),
                    sizeMm: z.number().positive(),
                })
                .nullable(),
            defaultQr: PrintQrPlacementSchema.nullable(),
        }),
    ),
    coverQr: PrintQrPlacementSchema,
});
export const PrintPdfBodySchema = z.object({
    versionId: IdSchema.optional(),
    qrPlacements: z.array(PrintQrPlacementSchema).max(201).optional(),
    kind: z.enum(['PRINT', 'MARKER_SHEET']).default('PRINT'),
    /** Where the QR goes in a PRINT file. */
    qrMode: z.enum(['COVER_ONLY', 'ALL_AR_PAGES']).default('COVER_ONLY'),
    /** Trim margin in millimetres. */
    bleedMm: z.number().min(0).max(10).default(0),
});
export type PrintPdfBody = z.infer<typeof PrintPdfBodySchema>;
