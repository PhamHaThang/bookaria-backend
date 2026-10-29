import { z } from 'zod';
import { IdSchema, MarkerTransformSchema } from '../../schema';
import { JobError } from '../jobs/jobs.types';
import type { PublishSnapshot } from '../publish/publish.types';

const FileSchema = z.object({
    publicId: z.string().min(1),
    format: z.string().min(1),
    pageAspect: z.number().min(0.2).max(5).optional(),
});
export const PrintSourceSchema = z.object({
    schemaVersion: z.literal(1),
    title: z.string(),
    widthMm: z.number().positive().max(1000),
    heightMm: z.number().positive().max(5000),
    pages: z
        .array(
            z.object({
                pageId: IdSchema,
                title: z.string().nullable(),
                image: FileSchema,
                marker: z.discriminatedUnion('mode', [
                    z.object({ mode: z.literal('NONE') }),
                    z.object({ mode: z.literal('CUSTOM_MARKER') }),
                    z.object({
                        mode: z.literal('BOOKARIA_MARKER'),
                        number: z.number().int().positive(),
                        image: FileSchema,
                        transform: MarkerTransformSchema,
                    }),
                ]),
            }),
        )
        .min(1),
});
export type PrintSource = z.infer<typeof PrintSourceSchema>;
export type PrintFile = z.infer<typeof FileSchema>;

/** Capture identifiers and geometry, not bytes; keep these media immutable in storage. */
export function capturePrintSource(snapshot: PublishSnapshot): PrintSource {
    const width = Number(snapshot.book.page_width_mm);
    return PrintSourceSchema.parse({
        schemaVersion: 1,
        title: snapshot.book.title,
        widthMm: width,
        heightMm: width * Number(snapshot.book.page_aspect),
        pages: snapshot.pages.map((page) => {
            const image = snapshot.assets.find((asset) => asset.id === page.image_asset_id);
            if (image?.resource_type !== 'image')
                throw new JobError('PRINT_SOURCE_IMAGE', 'Ảnh trang không hợp lệ.');
            const marker = snapshot.markers.find((value) => value.id === page.bookaria_marker_id);
            return {
                pageId: page.id,
                title: page.title,
                image: {
                    publicId: image.original_public_id,
                    format: image.format,
                    pageAspect: Number(snapshot.book.page_aspect),
                },
                marker:
                    page.marker_mode === 'BOOKARIA_MARKER'
                        ? {
                              mode: page.marker_mode,
                              number: marker?.number,
                              image: { publicId: marker?.image_public_id, format: 'png' },
                              transform: page.bookaria_marker_transform,
                          }
                        : { mode: page.marker_mode },
            };
        }),
    });
}
