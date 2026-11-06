import { describe, expect, it } from 'vitest';
import {
    ActionSchema,
    findSceneReferenceIssues,
    ModelControlSchema,
    PublishedSceneSchema,
    SceneObjectSchema,
    SceneSchema,
} from '../scene.schema';

const model = {
    id: 'car',
    type: 'model',
    assetId: '11111111-1111-4111-8111-111111111111',
    transform: {},
};
const scene = (objectId = 'car') =>
    SceneSchema.parse({
        schemaVersion: 1,
        objects: [model, { id: 'text', type: 'text', text: 'Nhãn', transform: {} }],
        interactions: [
            {
                id: 'move',
                trigger: { type: 'onPageEnter' },
                actions: [{ type: 'controlModel', objectId, operation: 'enable' }],
            },
        ],
    });
describe('reader model controls contract', () => {
    it('keeps legacy models unchanged and supplies safe opt-in defaults', () => {
        expect(SceneObjectSchema.parse(model)).not.toHaveProperty('controls');
        expect(ModelControlSchema.parse({})).toEqual({
            enabled: false,
            speed: 0.3,
            bounds: 'page',
            autoRotate: true,
            forwardAxis: '+z',
        });
        const parsed = SceneObjectSchema.parse({
            ...model,
            controls: {
                enabled: true,
                speed: 0.1,
                bounds: 'free',
                autoRotate: false,
                idleClip: 'Idle',
                moveClip: 'Run',
            },
        });
        expect(SceneObjectSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });
    it('rejects invalid speed and movement bounds', () => {
        for (const speed of [0, -1, Infinity, NaN, 5.1])
            expect(ModelControlSchema.safeParse({ speed }).success).toBe(false);
        expect(ModelControlSchema.safeParse({ bounds: 'screen' }).success).toBe(false);
        expect(ModelControlSchema.safeParse({ idleClip: '' }).success).toBe(false);
        expect(ModelControlSchema.safeParse({ moveClip: 'x'.repeat(101) }).success).toBe(false);
        expect(ModelControlSchema.safeParse({ forwardAxis: 'auto' }).success).toBe(false);
        expect(ModelControlSchema.safeParse({ speed: 0.01 }).success).toBe(true);
        expect(ModelControlSchema.safeParse({ speed: 5 }).success).toBe(true);
    });
    it('supports all control operations and rejects invalid operations', () => {
        for (const operation of ['enable', 'disable', 'reset']) {
            const action = ActionSchema.parse({ type: 'controlModel', objectId: 'car', operation });
            expect(action).toMatchObject({
                type: 'controlModel',
                objectId: 'car',
                operation,
                delayMsSchema: 0,
            });
        }
        expect(
            ActionSchema.safeParse({ type: 'controlModel', objectId: 'car', operation: 'move' })
                .success,
        ).toBe(false);
    });
    it('only permits existing 3D model targets when publishing', () => {
        expect(findSceneReferenceIssues(scene())).toEqual([]);
        expect(PublishedSceneSchema.safeParse(scene()).success).toBe(true);
        for (const target of ['missing', 'text']) {
            expect(findSceneReferenceIssues(scene(target))).toHaveLength(1);
            expect(PublishedSceneSchema.safeParse(scene(target)).success).toBe(false);
        }
    });
});
