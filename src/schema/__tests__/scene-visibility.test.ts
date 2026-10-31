import { describe, expect, it } from 'vitest';
import { PublishedSceneSchema, SceneObjectSchema, SceneSchema } from '../scene.schema';

const assetId = '11111111-1111-4111-8111-111111111111';
const text = { id: 'text', type: 'text', text: 'Nội dung', transform: {} };

describe('shared object visibility', () => {
    it('folds old editor hiding into a single flag without mutating or retaining the retired field', () => {
        for (const visible of [true, false]) {
            for (const editorHidden of [true, false]) {
                const input = { ...text, visible, editorHidden };
                const scene = SceneSchema.parse({ schemaVersion: 1, objects: [input] });
                expect(scene.objects[0]?.visible).toBe(visible && !editorHidden);
                expect(scene.objects[0]).not.toHaveProperty('editorHidden');
                expect(input.editorHidden).toBe(editorHidden);
                expect(PublishedSceneSchema.parse(JSON.parse(JSON.stringify(scene)))).toEqual(
                    scene,
                );
                // The user can show a previously hidden object after reopening it.
                expect(
                    SceneObjectSchema.parse({ ...scene.objects[0], visible: true }).visible,
                ).toBe(true);
            }
        }
    });
    it('defaults audio cards to hidden and other objects to shown; explicit choices survive saving', () => {
        for (const type of ['model', 'image', 'video', 'audio', 'text', 'label', 'hotspot']) {
            const input = { ...text, type, assetId };
            expect(SceneObjectSchema.parse(input).visible).toBe(type !== 'audio');
            for (const visible of [true, false]) {
                const object = SceneObjectSchema.parse({ ...input, visible });
                expect(SceneObjectSchema.parse(JSON.parse(JSON.stringify(object))).visible).toBe(
                    visible,
                );
                expect(object).not.toHaveProperty('editorHidden');
            }
        }
    });
    it('continues validating object data and the legacy flag on input', () => {
        expect(SceneObjectSchema.safeParse({ ...text, visible: 'false' }).success).toBe(false);
        expect(SceneObjectSchema.safeParse({ ...text, editorHidden: 'false' }).success).toBe(false);
        expect(SceneObjectSchema.safeParse({ ...text, type: 'unknown' }).success).toBe(false);
    });
});
