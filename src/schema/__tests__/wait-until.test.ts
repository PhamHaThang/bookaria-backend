import { describe, expect, it } from 'vitest';
import {
    ActionSchema,
    findSceneReferenceIssues,
    InteractionRuleSchema,
    SceneSchema,
} from '../scene.schema';

const wait = {
    type: 'waitUntil',
    test: { type: 'variable', key: 'score', operator: 'gte', value: 3 },
};
const rule = {
    id: 'unlock',
    trigger: { type: 'onPageEnter' },
    actions: [wait, { type: 'setState', key: 'done', operation: 'set', value: true }],
};

describe('wait until a condition becomes true', () => {
    it('accepts a sequential wait and roundtrips its single next port', () => {
        expect(InteractionRuleSchema.safeParse(rule).success).toBe(true);
        expect(
            InteractionRuleSchema.safeParse({ ...rule, trigger: { type: 'onPageLeave' } }).success,
        ).toBe(false);
        const graph = {
            ...rule,
            editorLayout: [
                { id: 'start', x: 0, y: 0 },
                { id: 'wait', x: 300, y: 0 },
                { id: 'done', x: 600, y: 0 },
            ],
            workflow: {
                version: 1,
                edges: [
                    { source: 'start', target: 'wait', port: 'next' },
                    { source: 'wait', target: 'done', port: 'next' },
                ],
            },
        };
        expect(
            InteractionRuleSchema.parse(JSON.parse(JSON.stringify(graph))).actions[0],
        ).toMatchObject(wait);
        graph.workflow.edges = [
            { source: 'start', target: 'wait', port: 'next' },
            { source: 'wait', target: 'done', port: 'true' },
        ];
        expect(InteractionRuleSchema.safeParse(graph).success).toBe(false);
    });

    it('rejects invalid predicates and deleted object or question references', () => {
        expect(
            ActionSchema.safeParse({ ...wait, test: { ...wait.test, value: true } }).success,
        ).toBe(false);
        for (const test of [
            { type: 'visible', objectId: 'deleted', value: true },
            { type: 'interactionCount', objectId: 'deleted', min: 1 },
            { type: 'answer', questionId: 'deleted', result: 'correct' },
        ]) {
            const scene = SceneSchema.parse({
                schemaVersion: 1,
                objects: [],
                interactions: [{ ...rule, actions: [{ ...wait, test }] }],
            });
            expect(findSceneReferenceIssues(scene)).toHaveLength(1);
        }
    });
});
