import { z } from 'zod';
import {
    BytesSchema,
    HttpUrlSchema,
    IdSchema,
    IsoDateTimeSchema,
    SceneIdSchema,
} from '../common.schema';
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
export const PrintPdfBodySchema = z.object({
    kind: z.enum(['PRINT', 'MARKER_SHEET']).default('PRINT'),
    /** Where the QR goes in a PRINT file. */
    qrMode: z.enum(['COVER_ONLY', 'ALL_AR_PAGES']).default('COVER_ONLY'),
    /** Trim margin in millimetres. */
    bleedMm: z.number().min(0).max(10).default(3),
});
export type PrintPdfBody = z.infer<typeof PrintPdfBodySchema>;
