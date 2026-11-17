import { describe, expect, it } from 'vitest';
import { InteractionRuleSchema } from '../scene.schema';

const movement = { type: 'transformTo', objectId: 'target', position: [1, 0, 0], durationMs: 200 };
const rule = {
    id: 'r',
    trigger: { type: 'onPageEnter' },
    actions: [movement, { type: 'wait', ms: 100 }, { ...movement, position: [0, 0, 0] }],
    editorLayout: ['start', 'a', 'wait', 'b'].map((id, x) => ({ id, x, y: 0 })),
    workflow: {
        version: 1,
        edges: [
            { source: 'start', target: 'a' },
            { source: 'a', target: 'wait' },
            { source: 'wait', target: 'b' },
        ],
    },
    movementLoop: {
        startId: 'a',
        endId: 'b',
        pauseMs: 500,
        initial: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
};
describe('movement loop', () => {
    it('persists an infinite movement segment without adding graph cycles or copied actions', () => {
        const saved = InteractionRuleSchema.parse(JSON.parse(JSON.stringify(rule)));
        expect(saved.movementLoop).toEqual(rule.movementLoop);
        expect(saved.actions).toHaveLength(3);
        expect(InteractionRuleSchema.safeParse({ ...rule, movementLoop: undefined }).success).toBe(
            true,
        );
    });
    it('rejects invalid boundaries, other actions/objects, page-leave loops and invalid timing', () => {
        for (const invalid of [
            { ...rule, movementLoop: { ...rule.movementLoop, startId: 'wait' } },
            { ...rule, movementLoop: { ...rule.movementLoop, endId: 'missing' } },
            { ...rule, movementLoop: { ...rule.movementLoop, pauseMs: -1 } },
            {
                ...rule,
                movementLoop: {
                    ...rule.movementLoop,
                    initial: { ...rule.movementLoop.initial, scale: [0, 1, 1] },
                },
            },
            { ...rule, workflow: undefined },
            { ...rule, editorLayout: undefined },
            { ...rule, trigger: { type: 'onPageLeave' } },
            {
                ...rule,
                actions: [
                    movement,
                    { type: 'setVisible', objectId: 'target', value: false },
                    movement,
                ],
            },
            {
                ...rule,
                actions: [movement, { type: 'wait', ms: 100 }, { ...movement, objectId: 'other' }],
            },
        ])
            expect(InteractionRuleSchema.safeParse(invalid).success).toBe(false);
    });
});
