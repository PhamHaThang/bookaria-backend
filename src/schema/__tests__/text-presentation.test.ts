import { describe, expect, it } from 'vitest';
import {
    SCREEN_BORDER_DEFAULTS,
    SceneObjectSchema,
    SceneSchema,
    sceneAssetIds,
} from '../scene.schema';

const image = '11111111-1111-4111-8111-111111111111';
const object = { id: 'text1', type: 'text', text: 'Xin chào Việt Nam', transform: {} };
describe('text presentations', () => {
    it('round-trips fixed connector edges without adding a property to legacy annotations', () => {
        for (const connectorSide of ['left', 'right', 'top', 'bottom']) {
            const presentation = { kind: 'annotation', connectorSide, labelOffset: [0.2, -0.1] };
            const parsed = SceneObjectSchema.parse({ ...object, presentation });
            expect(SceneObjectSchema.parse(JSON.parse(JSON.stringify(parsed)))).toMatchObject({
                presentation,
            });
        }
        expect(
            SceneObjectSchema.parse({ ...object, presentation: { kind: 'annotation' } }),
        ).not.toHaveProperty('presentation.connectorSide');
        for (const connectorSide of ['auto', 'upper-left', 'LEFT', '', null, 1])
            expect(
                SceneObjectSchema.safeParse({
                    ...object,
                    presentation: { kind: 'annotation', connectorSide },
                }).success,
            ).toBe(false);
    });

    it('round-trips annotation label offsets and rejects non-finite or malformed positions', () => {
        for (const shape of ['line', 'circle']) {
            const presentation = { kind: 'annotation', shape, labelOffset: [0.25, -0.15] };
            const parsed = SceneObjectSchema.parse({ ...object, presentation });
            expect(SceneObjectSchema.parse(JSON.parse(JSON.stringify(parsed)))).toMatchObject({
                presentation,
            });
            expect(
                SceneObjectSchema.parse({ ...object, presentation: { kind: 'annotation', shape } }),
            ).not.toHaveProperty('presentation.labelOffset');
        }
        for (const labelOffset of [[1], [1, 2, 3], [Number.NaN, 0], [0, Infinity], ['1', 0], null])
            expect(
                SceneObjectSchema.safeParse({
                    ...object,
                    presentation: { kind: 'annotation', labelOffset },
                }).success,
            ).toBe(false);
    });
    it('keeps old plain text and all supported presentations round-trippable', () => {
        expect(SceneObjectSchema.parse(object)).not.toHaveProperty('presentation');
        for (const presentation of [
            {
                kind: 'screen',
                title: 'Tiêu đề',
                imageAssetId: image,
                buttonLabel: 'Đọc thêm',
                buttonUrl: 'https://example.com',
            },
            { kind: 'bubble', title: 'Hướng dẫn', pointer: 'left' },
            { kind: 'extruded', depth: 0.03 },
            { kind: 'annotation', shape: 'circle', description: 'Giải thích' },
        ])
            expect(SceneObjectSchema.parse({ ...object, presentation })).toMatchObject({
                presentation,
            });
    });
    it('persists independent screen typography and button colour without changing old cards', () => {
        const presentation = {
            kind: 'screen',
            buttonBackground: '#252525',
            titleStyle: { size: 22, weight: 700, align: 'left' },
            bodyStyle: { size: 14, weight: 400, align: 'center' },
            buttonStyle: { size: 15, weight: 600, align: 'right' },
        };
        expect(SceneObjectSchema.parse({ ...object, presentation })).toMatchObject({
            presentation,
        });
        const legacy = SceneObjectSchema.parse({ ...object, presentation: { kind: 'screen' } });
        expect(legacy).not.toHaveProperty('presentation.titleStyle');
        for (const titleStyle of [
            { size: 0, weight: 400 },
            { size: 41, weight: 700 },
            { size: 14, weight: 900 },
            { size: 14, weight: 400, align: 'justify' },
        ])
            expect(
                SceneObjectSchema.safeParse({
                    ...object,
                    presentation: { kind: 'screen', titleStyle },
                }).success,
            ).toBe(false);
    });
    it.each(['screen', 'bubble'] as const)(
        '%s round-trips border options, preserves legacy options and rejects invalid strokes',
        (kind) => {
            const presentation = {
                kind,
                border: { enabled: false, color: '#252525', width: 4 },
            };
            expect(SceneObjectSchema.parse({ ...object, presentation })).toMatchObject({
                presentation,
            });
            expect(
                SceneObjectSchema.parse({ ...object, presentation: { kind, border: {} } }),
            ).toMatchObject({ presentation: { border: SCREEN_BORDER_DEFAULTS } });
            expect(
                SceneObjectSchema.parse({ ...object, presentation: { kind } }),
            ).not.toHaveProperty('presentation.border');
            for (const border of [{ width: 0 }, { width: 9 }, { width: 1.25 }, { color: 'red' }])
                expect(
                    SceneObjectSchema.safeParse({ ...object, presentation: { kind, border } })
                        .success,
                ).toBe(false);
        },
    );
    it('round-trips independent annotation description colours without changing old annotations', () => {
        const presentation = {
            kind: 'annotation',
            shape: 'circle',
            description: 'Mô tả tiếng Việt',
            descriptionColor: '#252525',
            descriptionBackground: '#e0f2fe',
        };
        expect(SceneObjectSchema.parse({ ...object, presentation })).toMatchObject({
            presentation,
        });
        const legacy = SceneObjectSchema.parse({
            ...object,
            presentation: { kind: 'annotation', shape: 'circle' },
        });
        expect(legacy).not.toHaveProperty('presentation.descriptionColor');
        expect(legacy).not.toHaveProperty('presentation.descriptionBackground');
        for (const colours of [{ descriptionColor: 'red' }, { descriptionBackground: '#fff' }])
            expect(
                SceneObjectSchema.safeParse({
                    ...object,
                    presentation: { ...presentation, ...colours },
                }).success,
            ).toBe(false);
    });
    it('preserves bubble pointer positions on all edges while legacy bubbles stay centred', () => {
        const legacy = SceneObjectSchema.parse({ ...object, presentation: { kind: 'bubble' } });
        expect(legacy).not.toHaveProperty('presentation.pointerPosition');
        for (const pointer of ['top', 'bottom', 'left', 'right']) {
            for (const pointerPosition of [0, 0.25, 0.5, 0.75, 1]) {
                const presentation = { kind: 'bubble', pointer, pointerPosition };
                const parsed = SceneObjectSchema.parse({ ...object, presentation });
                expect(SceneObjectSchema.parse(JSON.parse(JSON.stringify(parsed)))).toMatchObject({
                    presentation,
                });
            }
        }
        for (const pointerPosition of [
            -0.01,
            1.01,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            '0.5',
            null,
        ]) {
            expect(
                SceneObjectSchema.safeParse({
                    ...object,
                    presentation: { kind: 'bubble', pointerPosition },
                }).success,
            ).toBe(false);
        }
    });
    it('round-trips surface-anchored annotations while preserving legacy origins', () => {
        const legacy = SceneObjectSchema.parse({ ...object, presentation: { kind: 'annotation' } });
        expect(legacy).not.toHaveProperty('presentation.anchorAtTarget');
        for (const shape of ['line', 'circle']) {
            const presentation = { kind: 'annotation', shape, anchorAtTarget: true };
            const parsed = SceneObjectSchema.parse({ ...object, presentation });
            expect(SceneObjectSchema.parse(JSON.parse(JSON.stringify(parsed)))).toMatchObject({
                presentation,
            });
        }
        expect(
            SceneObjectSchema.safeParse({
                ...object,
                presentation: { kind: 'annotation', anchorAtTarget: 'yes' },
            }).success,
        ).toBe(false);
    });
    it('collects screen images for ownership checks, deletion protection and published manifests', () => {
        const scene = SceneSchema.parse({
            schemaVersion: 1,
            objects: [{ ...object, presentation: { kind: 'screen', imageAssetId: image } }],
            interactions: [],
        });
        expect(sceneAssetIds(scene)).toEqual([image]);
    });
    it('rejects unsafe links, unsupported shapes and excessive extrusion', () => {
        for (const presentation of [
            { kind: 'screen', buttonUrl: 'javascript:alert(1)' },
            { kind: 'annotation', shape: 'unknown' },
            { kind: 'extruded', depth: 2 },
        ])
            expect(SceneObjectSchema.safeParse({ ...object, presentation }).success).toBe(false);
    });
});
