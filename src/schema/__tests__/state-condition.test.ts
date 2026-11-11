import { describe, expect, it } from 'vitest';
import { InteractionRuleSchema, SceneSchema, TriggerSchema } from '../scene.schema';

const trigger = {
    type: 'onStateCondition',
    test: { type: 'variable', key: 'score', operator: 'gte', value: 3 },
};
describe('memory condition events', () => {
    it('roundtrips a condition event independently of conditional action branches', () => {
        const scene = SceneSchema.parse({
            schemaVersion: 1,
            objects: [],
            interactions: [
                {
                    id: 'reward',
                    trigger,
                    actions: [{ type: 'wait', ms: 0 }],
                },
            ],
        });
        expect(
            SceneSchema.parse(JSON.parse(JSON.stringify(scene))).interactions[0]?.trigger,
        ).toEqual(trigger);
        expect(InteractionRuleSchema.safeParse({ ...scene.interactions[0], trigger }).success).toBe(
            true,
        );
    });
    it('validates comparisons for number, boolean and string memory', () => {
        for (const value of [true, 'done', 3]) {
            expect(
                TriggerSchema.safeParse({
                    ...trigger,
                    test: { ...trigger.test, operator: 'eq', value },
                }).success,
            ).toBe(true);
        }
        for (const test of [
            { ...trigger.test, key: '' },
            { ...trigger.test, value: false },
            { ...trigger.test, operator: 'contains' },
            { type: 'visible', objectId: 'item', value: true },
        ])
            expect(TriggerSchema.safeParse({ ...trigger, test }).success).toBe(false);
    });
});
