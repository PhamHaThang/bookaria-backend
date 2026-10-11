import z from 'zod';
import { ManifestAssetSchema } from './asset.schema';
import { HttpUrlSchema, IdSchema, IsoDateTimeSchema } from './common.schema';
import { MarkerModeSchema } from './enums.schema';
import { MARKER_RULES, MarkerTransformSchema } from './marker.schema';
import { PageSettingsSchema, PublishedSceneSchema, sceneAssetIds } from './scene.schema';

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export const ManifestMarkerSchema = z
    .object({
        mode: MarkerModeSchema,
        number: z.int().positive().optional(),
        transform: MarkerTransformSchema.optional(),
    })
    .superRefine((m, ctx) => {
        if (m.mode === 'BOOKARIA_MARKER' && (m.number === undefined || m.transform === undefined)) {
            ctx.addIssue({
                code: 'custom',
                message: 'Marker Bookaria cần có số marker và vị trí',
            });
        }
    });
export type ManifestMarker = z.infer<typeof ManifestMarkerSchema>;

export const ManifestPageSchema = z
    .object({
        pageId: IdSchema,
        title: z.string().nullable().default(null),
        /** Height divided by width. */
        aspect: z.number().positive(),
        /** Page image: background of the 3D view. */
        imageUrl: HttpUrlSchema,
        /** Small image for the table of content. */
        thumbnailUrl: HttpUrlSchema,
        /** Which `.mind` file and which image in it. Absent for pages without AR (mode NONE). */
        group: z.int().min(0).optional(),
        targetIndex: z.int().min(0).optional(),
        marker: ManifestMarkerSchema,
        settings: PageSettingsSchema.prefault({}),
        scene: PublishedSceneSchema,
    })
    .superRefine((p, ctx) => {
        const hasTarget = p.group !== undefined && p.targetIndex !== undefined;
        if (p.marker.mode !== 'NONE' && !hasTarget) {
            ctx.addIssue({
                code: 'custom',
                message: 'Trang có AR cần có group và targetIndex',
            });
        }
        if (p.marker.mode === 'NONE' && (p.group !== undefined || p.targetIndex !== undefined)) {
            ctx.addIssue({
                code: 'custom',
                message: 'Trang không có AR không được có group hoặc targetIndex',
            });
        }
    });
export type ManifestPage = z.infer<typeof ManifestPageSchema>;

export const ManifestGroupSchema = z.object({
    group: z.int().min(0),
    mindUrl: HttpUrlSchema,
    pageIds: z.array(IdSchema).min(1).max(MARKER_RULES.maxPagesPerGroup),
});
export type ManifestGroup = z.infer<typeof ManifestGroupSchema>;

export const ManifestCreditSchema = z.object({
    assetId: IdSchema,
    name: z.string().optional(),
    license: z.string(),
    author: z.string(),
    sourceUrl: HttpUrlSchema.optional(),
});
export type ManifestCredit = z.infer<typeof ManifestCreditSchema>;
export const ManifestSchema = z
    .object({
        schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
        bookId: IdSchema,
        /** Version number of the published book. */
        version: z.int().positive(),
        title: z.string(),
        /** Tracking engine the `.mind` files were made for. */
        trackerEngine: z.literal('mindar'),
        generatedAt: IsoDateTimeSchema,
        targetGroups: z.array(ManifestGroupSchema),
        pages: z.array(ManifestPageSchema).min(1),
        assets: z.record(IdSchema, ManifestAssetSchema),
        credits: z.array(ManifestCreditSchema).default([]),
    })
    .superRefine((m, ctx) => {
        const fail = (path: (string | number)[], message: string) =>
            ctx.addIssue({ code: 'custom', path, message });

        const pageIds = new Set<string>();
        m.pages.forEach((p, i) => {
            if (pageIds.has(p.pageId)) fail(['pages', i, 'pageId'], 'Mã trang bị trùng');
            pageIds.add(p.pageId);
        });

        // Groups: unique numbers, listed pages exist and have AR.
        const groups = new Map<number, ManifestGroup>();
        m.targetGroups.forEach((g, i) => {
            if (groups.has(g.group)) fail(['targetGroups', i, 'group'], 'Số nhóm bị trùng');
            groups.set(g.group, g);
            g.pageIds.forEach((id, j) => {
                const page = m.pages.find((p) => p.pageId === id);
                if (!page)
                    fail(['targetGroups', i, 'pageIds', j], 'Nhóm trỏ tới trang không tồn tại');
                else if (page.marker.mode === 'NONE') {
                    fail(
                        ['targetGroups', i, 'pageIds', j],
                        'Trang không có AR không được nằm trong nhóm',
                    );
                }
            });
        });

        // Every AR page must sit exactly where its group says.
        const bookariaNumbers = new Set<number>();
        m.pages.forEach((p, i) => {
            if (p.group !== undefined && p.targetIndex !== undefined) {
                const g = groups.get(p.group);
                if (!g) fail(['pages', i, 'group'], `Không có nhóm số ${p.group}`);
                else if (g.pageIds[p.targetIndex] !== p.pageId) {
                    fail(
                        ['pages', i, 'targetIndex'],
                        'targetIndex không khớp vị trí của trang trong nhóm',
                    );
                }
            }
            const n = p.marker.number;
            if (n !== undefined) {
                if (bookariaNumbers.has(n))
                    fail(['pages', i, 'marker', 'number'], 'Số marker bị dùng hai lần');
                bookariaNumbers.add(n);
            }
            // Every asset the page uses must be listed.
            for (const assetId of sceneAssetIds(p.scene, p.settings)) {
                if (!m.assets[assetId])
                    fail(['pages', i, 'scene'], `Thiếu tài nguyên ${assetId} trong manifest`);
            }
        });
    });
export type Manifest = z.infer<typeof ManifestSchema>;
