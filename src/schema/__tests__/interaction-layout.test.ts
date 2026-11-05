import { describe, expect, it } from 'vitest';
import { InteractionRuleSchema, SceneSchema } from '../scene.schema';

const rule = {
    id: 'rule',
    trigger: { type: 'onPageEnter' },
    actions: [{ type: 'wait', ms: 10 }],
    editorLayout: [
        { id: 'start', x: 10, y: -20 },
        { id: 'step', x: 400, y: 80 },
    ],
};
describe('interaction authoring layout', () => {
    it('preserves layout through scene JSON parsing without changing execution order', () => {
        const saved = SceneSchema.parse(
            JSON.parse(JSON.stringify({ schemaVersion: 1, objects: [], interactions: [rule] })),
        );
        expect(saved.interactions[0]?.editorLayout).toEqual(rule.editorLayout);
        expect(saved.interactions[0]?.actions).toEqual(rule.actions);
        expect(InteractionRuleSchema.safeParse({ ...rule, editorLayout: undefined }).success).toBe(
            true,
        );
    });
    it('rejects unbounded, mismatched or duplicate layout nodes', () => {
        for (const editorLayout of [
            [{ id: 'start', x: Infinity, y: 0 }, rule.editorLayout[1]],
            [{ id: 'start', x: 100001, y: 0 }, rule.editorLayout[1]],
            [rule.editorLayout[0]],
            [rule.editorLayout[0], rule.editorLayout[0]],
            [rule.editorLayout[1], rule.editorLayout[0]],
        ]) {
            expect(InteractionRuleSchema.safeParse({ ...rule, editorLayout }).success).toBe(false);
        }
    });
});

describe('branching interaction workflow', () => {
    const branch = {
        id: 'unlock',
        trigger: { type: 'onMarkerFound' },
        actions: [
            {
                type: 'condition',
                test: { type: 'variable', key: 'score', operator: 'gte', value: 3 },
            },
            { type: 'setState', key: 'unlocked', operation: 'set', value: true },
            { type: 'setState', key: 'unlocked', operation: 'set', value: false },
        ],
        editorLayout: [
            { id: 'start', x: 0, y: 0 },
            { id: 'check', x: 300, y: 0 },
            { id: 'yes', x: 600, y: -100 },
            { id: 'no', x: 600, y: 100 },
        ],
        workflow: {
            version: 1,
            edges: [
                { source: 'start', target: 'check', port: 'next' },
                { source: 'check', target: 'yes', port: 'true' },
                { source: 'check', target: 'no', port: 'false' },
            ],
        },
    };
    it('roundtrips branch ports, node identities and all new triggers through JSON', () => {
        const parsed = InteractionRuleSchema.parse(JSON.parse(JSON.stringify(branch)));
        expect(parsed.workflow).toEqual(branch.workflow);
        for (const trigger of [
            { type: 'onMarkerFound' },
            { type: 'onMarkerLost' },
            { type: 'onAnimationEnd', objectId: 'model', clip: 'Walk' },
            { type: 'onAnswer', questionId: 'question', answer: 'correct' },
        ])
            expect(InteractionRuleSchema.safeParse({ ...branch, trigger }).success).toBe(true);
    });
    it('rejects missing branches, duplicate outputs, cycles, dangling nodes and graphless conditions', () => {
        const edges = branch.workflow.edges;
        for (const candidate of [
            edges.slice(0, 2),
            [...edges, { source: 'check', target: 'no', port: 'true' }],
            [...edges, { source: 'yes', target: 'check', port: 'next' }],
            [...edges, { source: 'yes', target: 'missing', port: 'next' }],
        ])
            expect(
                InteractionRuleSchema.safeParse({
                    ...branch,
                    workflow: { version: 1, edges: candidate },
                }).success,
            ).toBe(false);
        expect(InteractionRuleSchema.safeParse({ ...branch, workflow: undefined }).success).toBe(
            false,
        );
    });
    it('validates question answers, state value types and terminal navigation', () => {
        const valid = {
            id: 'quiz',
            trigger: { type: 'onPageEnter' },
            actions: [
                {
                    type: 'askQuestion',
                    question: {
                        questionId: 'question',
                        title: 'Chọn đáp án',
                        choices: [
                            { id: 'a', text: 'A' },
                            { id: 'b', text: 'B' },
                        ],
                        correctChoiceId: 'a',
                    },
                },
                { type: 'navigate', navigation: { target: 'end' } },
            ],
        };
        expect(InteractionRuleSchema.safeParse(valid).success).toBe(true);
        expect(
            InteractionRuleSchema.safeParse({ ...valid, trigger: { type: 'onPageLeave' } }).success,
        ).toBe(false);
        expect(
            InteractionRuleSchema.safeParse({
                ...valid,
                actions: [
                    {
                        ...valid.actions[0],
                        question: { ...valid.actions[0]?.question, correctChoiceId: 'missing' },
                    },
                ],
            }).success,
        ).toBe(false);
        expect(
            InteractionRuleSchema.safeParse({
                ...valid,
                actions: [{ type: 'setState', key: 'score', operation: 'increment', value: true }],
            }).success,
        ).toBe(false);
        expect(
            InteractionRuleSchema.safeParse({
                ...valid,
                actions: [{ type: 'navigate', navigation: { target: 'page' } }],
            }).success,
        ).toBe(false);
    });
});
