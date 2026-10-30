import { z } from 'zod';
import { IdSchema } from '../common.schema';
import { PageSchema, PageSummarySchema } from '../dto.schema';
import { PageFormatSchema } from '../enums.schema';
import { PageWidthMmSchema } from '../marker.schema';
import { PageSettingsSchema, SceneSchema, SceneWarningSchema } from '../scene.schema';

const draftId = IdSchema.transform((id) => id.toLowerCase());
export const BookDraftSnapshotSchema = z.object({
    bookId: IdSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    geometry: z.object({
        pageFormat: PageFormatSchema,
        pageAspect: z.number().min(0.2).max(5),
        pageWidthMm: PageWidthMmSchema,
    }),
    pages: z.array(PageSummarySchema),
    pageRevisions: z.record(IdSchema, z.int().min(0)),
});
export type BookDraftSnapshot = z.infer<typeof BookDraftSnapshotSchema>;

export const BookDraftPageChangeSchema = z
    .object({
        id: draftId,
        title: z.string().trim().max(200).nullable().optional(),
        imageAssetId: draftId.optional(),
        scene: SceneSchema.optional(),
        settings: PageSettingsSchema.optional(),
        markerMindPublicId: z.string().trim().min(1).max(300).optional(),
    })
    .refine((page) => Object.keys(page).some((key) => key !== 'id'), {
        error: 'Trang cần có ít nhất một thay đổi.',
    });
export type BookDraftPageChange = z.infer<typeof BookDraftPageChangeSchema>;

/** `order` is the complete desired page order. Omitted existing ids are deleted atomically. */
export const SaveBookDraftBodySchema = z
    .object({
        revision: BookDraftSnapshotSchema.shape.revision,
        order: z.array(draftId).max(1000),
        changes: z.array(BookDraftPageChangeSchema).max(1000),
    })
    .superRefine((body, ctx) => {
        if (new Set(body.order).size !== body.order.length)
            ctx.addIssue({
                code: 'custom',
                path: ['order'],
                message: 'Danh sách trang có mã bị trùng.',
            });
        const changed = new Set<string>();
        body.changes.forEach((page, index) => {
            if (changed.has(page.id) || !body.order.includes(page.id))
                ctx.addIssue({
                    code: 'custom',
                    path: ['changes', index, 'id'],
                    message: 'Mỗi thay đổi phải thuộc một trang duy nhất trong sách.',
                });
            changed.add(page.id);
        });
    });
export type SaveBookDraftBody = z.infer<typeof SaveBookDraftBodySchema>;
export const SaveBookDraftResultSchema = z.object({
    snapshot: BookDraftSnapshotSchema,
    pages: z.array(PageSchema),
    warnings: z.array(z.object({ pageId: IdSchema, warnings: z.array(SceneWarningSchema) })),
    jobs: z.array(z.object({ pageId: IdSchema, jobId: IdSchema })),
});
export type SaveBookDraftResult = z.infer<typeof SaveBookDraftResultSchema>;
