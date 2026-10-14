import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, shortText } from '../common.schema';
import { PageSummarySchema } from '../dto.schema';
import { LightingPresetSchema, MarkerModeSchema } from '../enums.schema';
import {
    BookariaMarkerPlacementSchema,
    MarkerReportSchema,
    MarkerScoreSchema,
    MarkerTransformSchema,
    MarkerWarningSchema,
} from '../marker.schema';
import { SceneSchema, SceneWarningSchema } from '../scene.schema';

// --- Adding, importing, ordering ----------------------------------------------------------------
/**
 * `POST /books/:bookId/pages`.
 * `afterPageId`: a page id inserts after it, `null` inserts at the very beginning,
 * omitted appends at the end.
 */
export const AddPageBodySchema = z.object({
    imageAssetId: IdSchema,
    afterPageId: IdSchema.nullable().optional(),
    title: shortText(200).optional(),
});
export type AddPageBody = z.infer<typeof AddPageBodySchema>;

export const AddPageResultSchema = z.object({
    page: PageSummarySchema.pick({
        id: true,
        orderIndex: true,
        markerMode: true,
        markerNumber: true,
    }),
    warnings: z.array(MarkerWarningSchema).optional(),
});

/** `PATCH .../pages/reorder`: send ALL page ids in the new order. */
export const ReorderPagesBodySchema = z.object({
    pageIds: z
        .array(IdSchema)
        .min(1)
        .refine((ids) => new Set(ids).size === ids.length, {
            error: 'Danh sách trang có mã bị trùng lặp',
        }),
});
export type ReorderPagesBody = z.infer<typeof ReorderPagesBodySchema>;

export const ReorderPagesResultSchema = z.object({
    pages: z.array(z.object({ id: IdSchema, orderIndex: z.int().min(0) })),
});

// --- Editing a page ------------------------------------------------------------------------------
export const PageSettingsPatchSchema = z.object({
    backgroundAudioAssetId: IdSchema.nullable().optional(),
    backgroundLoop: z.boolean().optional(),
    narrationAssetId: IdSchema.nullable().optional(),
    lighting: LightingPresetSchema.optional(),
});
export type PageSettingsPatch = z.infer<typeof PageSettingsPatchSchema>;

/** `PATCH /pages/:pageId`. `noAr: true` marks a text-only page (marker mode NONE). */
export const UpdatePageBodySchema = z
    .object({
        title: z.string().trim().max(150).nullable().optional(),
        settings: PageSettingsPatchSchema.optional(),
        noAr: z.boolean().optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
        error: 'Cần gửi ít nhất một trường để sửa',
    });
export type UpdatePageBody = z.infer<typeof UpdatePageBodySchema>;

/**
 * `PUT /pages/:pageId/image`. A custom-marker page must send the `.mind` file compiled in the
 * browser from the new image.
 */
export const ReplacePageImageBodySchema = z.object({
    imageAssetId: IdSchema,
    markerMindPublicId: z.string().trim().min(1).max(300).optional(),
});
export type ReplacePageImageBody = z.infer<typeof ReplacePageImageBodySchema>;

export const ReplacePageImageResultSchema = z.object({
    page: PageSummarySchema,
    jobId: IdSchema.optional(),
});

// --- Scene ---------------------------------------------------------------------------------------
/** `PATCH /pages/:pageId/scene`: save the whole scene with the revision you loaded. */
export const SaveSceneBodySchema = z.object({
    revision: z.int().min(0),
    scene: SceneSchema,
});
export type SaveSceneBody = z.infer<typeof SaveSceneBodySchema>;

export const SaveSceneResultSchema = z.object({
    revision: z.int().min(0),
    updatedAt: IsoDateTimeSchema,
    warnings: z.array(SceneWarningSchema).optional(),
});
export type SaveSceneResult = z.infer<typeof SaveSceneResultSchema>;

// --- Marker ----------------------------------------------------------------------
/**
 * `PUT /pages/:pageId/marker`:
 * - `BOOKARIA_MARKER`: back to a Bookaria marker, optionally at a new position and size.
 * - `CUSTOM_MARKER`: use the page image; send the `.mind` file the browser compiled.
 */
export const UpdateMarkerBodySchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('BOOKARIA_MARKER'), transform: MarkerTransformSchema.optional() }),
    z.object({ mode: z.literal('CUSTOM_MARKER'), markerMindPublicId: z.string().min(1).max(300) }),
]);
export type UpdateMarkerBody = z.infer<typeof UpdateMarkerBodySchema>;

export const BookariaMarkerResultSchema = z.object({
    markerMode: z.literal('BOOKARIA_MARKER'),
    markerNumber: z.int().positive(),
    transform: MarkerTransformSchema,
});

export const CustomMarkerResultSchema = z.object({
    markerMode: z.literal('CUSTOM_MARKER'),
    markerNumber: z.null(),
    markerScore: z.null(),
    jobId: IdSchema,
});

/** `GET /pages/:pageId/marker` */
export const MarkerInfoSchema = z.object({
    markerMode: MarkerModeSchema,
    markerNumber: z.int().positive().nullable(),
    bookariaMarker: BookariaMarkerPlacementSchema.nullable(),
    markerScore: MarkerScoreSchema.nullable(),
    markerReport: MarkerReportSchema.nullable(),
    markerWarnings: z.array(MarkerWarningSchema),
});
export type MarkerInfo = z.infer<typeof MarkerInfoSchema>;
