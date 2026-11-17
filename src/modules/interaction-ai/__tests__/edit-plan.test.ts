import { describe, expect, it } from 'vitest';
import { applyAiObjectEdits } from '../../../schema/api/interaction-ai.schema';
import { SceneSchema } from '../../../schema/scene.schema';
import { type GenerationContext, generationMessages, validateCandidate } from '../generation';

const pageId = '11111111-1111-4111-8111-111111111111';
const context: GenerationContext = {
    scene: SceneSchema.parse({
        schemaVersion: 1,
        objects: [{ id: 'card', type: 'text', text: 'Gợi ý', transform: {} }],
    }),
    assets: [],
    editor: { variables: [], pages: [{ id: pageId, title: 'Trang tiếp' }], hasMarker: true },
};
const quiz = {
    name: 'Thử thách Rùa',
    trigger: { type: 'onTap', objectId: 'card' },
    actions: [
        {
            type: 'askQuestion',
            question: {
                questionId: 'quiz',
                title: 'Rùa sống ở đâu?',
                choices: [
                    { id: 'a', text: 'Biển' },
                    { id: 'b', text: 'Mặt Trăng' },
                ],
                correctChoiceId: 'a',
            },
        },
        { type: 'condition', test: { type: 'answer', questionId: 'quiz', result: 'correct' } },
        { type: 'setState', key: 'score', operation: 'increment', value: 1 },
        { type: 'navigate', navigation: { target: 'page', pageId } },
        { type: 'setVisible', objectId: 'card', value: true },
    ],
    edges: [
        { from: -1, to: 0 },
        { from: 0, to: 1 },
        { from: 1, to: 2, port: 'true' },
        { from: 2, to: 3 },
        { from: 1, to: 4, port: 'false' },
    ],
};
const score = { key: 'score', name: 'Điểm', initialValue: 0, type: 'number' };
const plan = (rules: unknown[], variables: unknown[] = [score]) =>
    JSON.stringify({ status: 'edit_plan', rules, variables });

describe('editor plan compiler', () => {
    it('creates black text at the center of the page without a library asset', () => {
        const candidate = {
            status: 'edit_plan',
            rules: [],
            objectAdds: [
                {
                    localId: 'new-text',
                    type: 'text',
                    text: 'Hãy là chính mình',
                    style: { color: '#000000' },
                    transform: { position: [0, 0, 0] },
                },
            ],
        };
        const result = validateCandidate(JSON.stringify(candidate), context);
        if (!result.ok || result.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(result));
        const added = result.output.plan.objectAdds?.[0];
        expect(added).toMatchObject({
            text: 'Hãy là chính mình',
            style: { color: '#000000' },
            transform: { position: [0, 0, 0] },
        });
        expect(added?.id).not.toBe('new-text');
        expect(added).not.toHaveProperty('assetId');
        const invalid = {
            ...candidate,
            objectAdds: [{ ...candidate.objectAdds[0], type: 'hotspot' }],
        };
        expect(validateCandidate(JSON.stringify(invalid), context).ok).toBe(false);
    });
    it('validates and merges card typography, media settings and model controls', () => {
        const modelAsset = '11111111-1111-4111-8111-111111111111';
        const videoAsset = '22222222-2222-4222-8222-222222222222';
        const scene = SceneSchema.parse({
            ...context.scene,
            objects: [
                {
                    id: 'card',
                    type: 'text',
                    text: 'Nội dung',
                    transform: {},
                    presentation: {
                        kind: 'screen',
                        title: 'Tiêu đề',
                        bodyStyle: { size: 14, weight: 700, align: 'right' },
                        border: { color: '#111111' },
                    },
                },
                {
                    id: 'model',
                    type: 'model',
                    assetId: modelAsset,
                    transform: {},
                    controls: { enabled: true, idleClip: 'Idle' },
                },
                {
                    id: 'video',
                    type: 'video',
                    assetId: videoAsset,
                    transform: {},
                    autoplay: true,
                    loop: true,
                },
            ],
        });
        const scoped = {
            ...context,
            scene,
            assets: [
                { id: modelAsset, name: 'Robot', type: 'MODEL', animations: ['Idle', 'Run'] },
                { id: videoAsset, name: 'Video', type: 'VIDEO', animations: [] },
            ],
        };
        const compile = (objectEdits: unknown[]) =>
            validateCandidate(
                JSON.stringify({ status: 'edit_plan', rules: [], objectEdits }),
                scoped,
            );
        const result = compile([
            {
                objectId: 'card',
                presentation: { kind: 'screen', bodyStyle: { size: 22 }, border: { width: 2 } },
            },
            { objectId: 'model', properties: { type: 'model', controls: { moveClip: 'Run' } } },
            { objectId: 'video', properties: { type: 'video', autoplay: false, volume: 0 } },
        ]);
        if (!result.ok || result.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(result));
        const [card, model, video] = applyAiObjectEdits(
            scene.objects,
            result.output.plan.objectEdits ?? [],
        );
        expect(card).toMatchObject({
            presentation: {
                title: 'Tiêu đề',
                bodyStyle: { size: 22, weight: 700, align: 'right' },
                border: { color: '#111111', width: 2 },
            },
        });
        expect(model).toMatchObject({
            controls: { enabled: true, idleClip: 'Idle', moveClip: 'Run' },
        });
        expect(video).toMatchObject({ autoplay: false, loop: true, volume: 0 });
        expect(
            compile([
                {
                    objectId: 'model',
                    properties: { type: 'model', animation: { clip: 'Missing' } },
                },
            ]).ok,
        ).toBe(false);
        expect(
            compile([{ objectId: 'video', properties: { type: 'image', opacity: 0.3 } }]).ok,
        ).toBe(false);
    });
    it('places approved assets and connects new objects to a rule in the same proposal', () => {
        const assetId = '22222222-2222-4222-8222-222222222222';
        const candidate = {
            status: 'edit_plan',
            objectAdds: [
                { localId: 'new-image', type: 'image', assetId, name: 'Ảnh rùa' },
                { localId: 'new-copy', duplicateOf: 'card', name: 'Bản sao' },
            ],
            rules: [
                {
                    name: 'Hiện bản sao',
                    trigger: { type: 'onTap', objectId: 'new-image' },
                    actions: [{ type: 'setVisible', objectId: 'new-copy', value: true }],
                },
            ],
        };
        const output = JSON.stringify(candidate);
        expect(validateCandidate(output, context).ok).toBe(false);
        const result = validateCandidate(output, {
            ...context,
            assets: [{ id: assetId, type: 'IMAGE', name: 'Ảnh rùa', animations: [] }],
        });
        if (!result.ok || result.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(result));
        const { objectAdds, rules } = result.output.plan;
        expect(objectAdds).toMatchObject([
            { type: 'image', assetId },
            { text: 'Gợi ý', name: 'Bản sao' },
        ]);
        expect(objectAdds?.[0]?.id).not.toBe('new-image');
        expect(rules[0]?.rule.trigger).toMatchObject({ objectId: objectAdds?.[0]?.id });
        expect(rules[0]?.rule.actions[0]).toMatchObject({ objectId: objectAdds?.[1]?.id });
    });

    it('blocks removal that breaks an existing flow, and accepts explicit removal of both', () => {
        const scoped = {
            ...context,
            scene: SceneSchema.parse({
                ...context.scene,
                interactions: [
                    {
                        id: 'linked',
                        name: 'Mở gợi ý',
                        trigger: { type: 'onTap', objectId: 'card' },
                        actions: [{ type: 'wait', ms: 0 }],
                    },
                ],
            }),
        };
        const onlyObject = { status: 'edit_plan', rules: [], removeObjectIds: ['card'] };
        const broken = validateCandidate(JSON.stringify(onlyObject), scoped);
        expect(broken.ok).toBe(false);
        if (!broken.ok) expect(broken.errors.join(' ')).toContain('Mở gợi ý');
        const result = validateCandidate(
            JSON.stringify({ ...onlyObject, removeRuleIds: ['linked'] }),
            scoped,
        );
        if (!result.ok || result.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(result));
        expect(result.output.plan).toMatchObject({
            removeObjectIds: ['card'],
            removeRuleIds: ['linked'],
        });
    });

    it('keeps untouched transform axes and permits a single draft edit with a runtime rule', () => {
        const objectEdits = [{ objectId: 'card', visible: false, transform: { scale: [2, 2, 2] } }];
        const result = validateCandidate(
            JSON.stringify({
                status: 'edit_plan',
                objectEdits,
                rules: [
                    {
                        name: 'Hiện thẻ',
                        trigger: { type: 'onPageEnter' },
                        actions: [{ type: 'setVisible', objectId: 'card', value: true }],
                    },
                ],
            }),
            context,
        );
        if (!result.ok || result.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(result));
        expect(result.output.plan.objectEdits).toEqual(objectEdits);
        expect(
            applyAiObjectEdits(context.scene.objects, result.output.plan.objectEdits ?? []),
        ).toMatchObject([
            {
                visible: false,
                transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
            },
        ]);
        expect(context.scene.objects[0]?.visible).toBe(true);
    });

    it('keeps object-only plans within the selected scope and rejects unsafe patches', () => {
        if (!context.editor) throw new Error('Editor context missing');
        const scoped = {
            ...context,
            editor: { ...context.editor, selectedObjectId: 'card' },
            scene: SceneSchema.parse({
                ...context.scene,
                objects: [
                    ...context.scene.objects,
                    { id: 'locked', type: 'text', text: 'Khóa', transform: {}, locked: true },
                    { id: 'spot', type: 'hotspot', transform: {} },
                ],
            }),
        };
        const edit = (objectEdits: unknown[]) =>
            JSON.stringify({ status: 'edit_plan', rules: [], objectEdits });
        expect(
            validateCandidate(edit([{ objectId: 'card', text: 'Nội dung mới' }]), scoped).ok,
        ).toBe(true);
        expect(validateCandidate(edit([{ objectId: 'spot', visible: false }]), scoped).ok).toBe(
            false,
        );
        for (const invalid of [
            [],
            [{ objectId: 'missing', visible: false }],
            [{ objectId: 'locked', visible: false }],
            [{ objectId: 'spot', text: 'Sai loại' }],
            [{ objectId: 'card', visible: true }],
            [{ objectId: 'card', id: 'new-id', visible: false }],
            [
                { objectId: 'card', visible: false },
                { objectId: 'card', name: 'Đổi tên' },
            ],
        ])
            expect(validateCandidate(edit(invalid), { ...scoped, editor: context.editor }).ok).toBe(
                false,
            );
    });

    it('edits text colors without resetting size, font or unrequested card settings', () => {
        if (!context.editor) throw new Error('Editor context missing');
        const scene = SceneSchema.parse({
            ...context.scene,
            objects: [
                {
                    id: 'card',
                    type: 'text',
                    text: 'Gợi ý',
                    transform: {},
                    style: { color: '#404040', size: 0.09, font: 'serif', bold: true },
                    presentation: {
                        kind: 'screen',
                        title: 'Thẻ',
                        background: '#ffffff',
                        buttonLabel: 'Đọc tiếp',
                        buttonUrl: 'https://example.test/path',
                    },
                },
                { id: 'spot', type: 'hotspot', transform: {} },
            ],
        });
        const edited = {
            objectId: 'card',
            style: { color: '#ff0000' },
            presentation: { kind: 'screen', background: '#f1f5f9' },
        };
        const scoped = {
            ...context,
            scene,
            editor: { ...context.editor, selectedObjectId: 'card', pageWidthMm: 210 },
        };
        const output = (patch: object) =>
            JSON.stringify({ status: 'edit_plan', rules: [], objectEdits: [patch] });
        const result = validateCandidate(output(edited), scoped);
        if (!result.ok || result.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(result));
        expect(result.output.plan.objectEdits).toEqual([edited]);
        expect(
            applyAiObjectEdits(scene.objects, result.output.plan.objectEdits ?? [])[0],
        ).toMatchObject({
            text: 'Gợi ý',
            style: { color: '#ff0000', size: 0.09, font: 'serif', bold: true },
            presentation: {
                kind: 'screen',
                background: '#f1f5f9',
                buttonUrl: 'https://example.test/path',
            },
        });
        const prompt = generationMessages('Đổi màu chữ thành đỏ', scoped)[1]?.content ?? '';
        expect(prompt).toContain('"pageWidthMm":210');
        expect(prompt).toContain('#404040');
        expect(prompt).not.toContain('https://example.test/path');
        for (const invalid of [
            { objectId: 'spot', style: { color: '#ff0000' } },
            { objectId: 'card', style: { color: 'red' } },
            { objectId: 'card', style: {} },
            { objectId: 'card', presentation: { kind: 'bubble', background: '#000000' } },
            {
                objectId: 'card',
                presentation: { kind: 'screen', buttonUrl: 'https://example.test/other' },
            },
        ])
            expect(
                validateCandidate(output(invalid), { ...scoped, editor: context.editor }).ok,
            ).toBe(false);
    });
    it('restricts an explicit rule scope to updating that one rule', () => {
        if (!context.editor) throw new Error('Editor context missing');
        const rule = {
            id: 'chosen',
            name: 'Luồng đang sửa',
            enabled: true,
            onRetrigger: 'ignore',
            trigger: { type: 'onPageEnter' },
            actions: [{ type: 'wait', ms: 1000 }],
        };
        const scoped = {
            ...context,
            scene: SceneSchema.parse({ ...context.scene, interactions: [rule] }),
            editor: { ...context.editor, selectedRuleId: rule.id },
        };
        const candidate = {
            name: rule.name,
            trigger: rule.trigger,
            actions: [{ type: 'wait', ms: 2000 }],
        };
        const valid = validateCandidate(plan([{ ...candidate, replaceId: rule.id }], []), scoped);
        expect(valid.ok).toBe(true);
        for (const output of [
            plan([candidate], []),
            plan([{ ...candidate, replaceId: 'other' }], []),
            plan([{ ...candidate, replaceId: rule.id }, candidate], []),
            JSON.stringify({ status: 'proposal', rule: candidate }),
        ]) {
            const result = validateCandidate(output, scoped);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.errors.join(' ')).toContain('Phạm vi');
        }
    });
    it('keeps loop anchors, wires and hand-placed nodes when renaming or inserting a step', () => {
        const object = context.scene.objects[0];
        if (!object) throw new Error('Missing fixture object');
        const transform = object.transform;
        const action = {
            type: 'transformTo',
            objectId: 'card',
            position: [0.5, 0, 0],
            durationMs: 500,
        };
        const scene = SceneSchema.parse({
            ...context.scene,
            interactions: [
                {
                    id: 'motion',
                    name: 'Đi rồi lặp',
                    trigger: { type: 'onPageEnter' },
                    actions: [action],
                    editorLayout: [
                        { id: 'start', x: 40, y: 80 },
                        { id: 'out', x: 500, y: 260 },
                    ],
                    workflow: {
                        version: 1,
                        edges: [{ source: 'start', target: 'out', port: 'next' }],
                    },
                    movementLoop: {
                        startId: 'out',
                        endId: 'out',
                        initial: transform,
                        pauseMs: 100,
                    },
                },
            ],
        });
        const old = scene.interactions[0];
        if (!old) throw new Error('Missing fixture rule');
        const scoped = { ...context, scene };
        const candidate = {
            replaceId: old.id,
            name: 'Tên mới',
            trigger: old.trigger,
            actions: [action],
        };
        const rename = validateCandidate(plan([candidate], []), scoped);
        if (!rename.ok || rename.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(rename));
        expect(rename.output.plan.rules[0]?.rule).toEqual({ ...old, name: candidate.name });

        const insert = validateCandidate(
            plan(
                [
                    {
                        ...candidate,
                        stepIds: [null, 'out'],
                        actions: [
                            { type: 'wait', ms: 2000 },
                            { ...action, durationMs: 750 },
                        ],
                    },
                ],
                [],
            ),
            scoped,
        );
        if (!insert.ok || insert.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(insert));
        const updated = insert.output.plan.rules[0]?.rule;
        if (!updated) throw new Error('Missing updated rule');
        expect(updated.movementLoop).toEqual(old.movementLoop);
        expect(updated.editorLayout?.[2]).toEqual(old.editorLayout?.[1]);
        expect(updated.workflow?.edges[1]).toMatchObject({ target: 'out' });
        expect(validateCandidate(plan([{ ...candidate, stepIds: [null] }], []), scoped).ok).toBe(
            false,
        );
    });
    it('sends full actions only for the selected rule even on dense valid pages', () => {
        const scene = SceneSchema.parse({
            ...context.scene,
            interactions: Array.from({ length: 25 }, (_, index) => ({
                id: `rule-${index}`,
                name: `Luồng ${index}`,
                trigger: { type: 'onPageEnter' },
                actions: Array.from({ length: 20 }, () => ({
                    type: 'transformTo',
                    objectId: 'card',
                    position: [0.5, 0, 0],
                    durationMs: 500,
                })),
            })),
        });
        if (!context.editor) throw new Error('Editor context missing');
        const editor = { ...context.editor, selectedRuleId: 'rule-0' };
        const messages = generationMessages('Đổi tên luồng này', { ...context, scene, editor });
        const request = JSON.parse(messages[1]?.content ?? '{}');
        expect(request.interactions).toHaveLength(25);
        expect(request.interactions[0].actions).toHaveLength(20);
        expect(request.interactions[1]).not.toHaveProperty('actions');
        expect(JSON.stringify(messages).length).toBeLessThan(64000);
    });
    it('compiles a branched quiz and binds the same new question in another rule', () => {
        const result = validateCandidate(
            plan([
                quiz,
                {
                    name: 'Phản hồi sai',
                    trigger: { type: 'onAnswer', questionId: 'quiz', answer: 'incorrect' },
                    actions: [{ type: 'wait', ms: 0 }],
                },
            ]),
            context,
        );
        if (!result.ok || result.output.status !== 'edit_plan')
            throw new Error(JSON.stringify(result));
        const [main, followup] = result.output.plan.rules;
        const question = main?.rule.actions[0];
        expect(question?.type).toBe('askQuestion');
        if (question?.type !== 'askQuestion') throw new Error('Question missing');
        expect(question.question.questionId).not.toBe('quiz');
        expect(question.question.correctChoiceId).toBe(question.question.choices[0]?.id);
        expect(main?.rule.actions[1]).toMatchObject({
            test: { questionId: question.question.questionId },
        });
        expect(
            main?.rule.workflow?.edges
                .filter((edge) => edge.source === 'action-1')
                .map((edge) => edge.port),
        ).toEqual(['true', 'false']);
        expect(followup?.rule.trigger).toMatchObject({ questionId: question.question.questionId });
        expect(result.output.plan.variables).toEqual([score]);
    });

    it('targets stable IDs even with duplicate names and preserves question references', () => {
        const initial = validateCandidate(
            plan([
                quiz,
                {
                    name: quiz.name,
                    trigger: { type: 'onPageEnter' },
                    actions: [{ type: 'wait', ms: 0 }],
                },
            ]),
            context,
        );
        if (!initial.ok || initial.output.status !== 'edit_plan' || !context.editor)
            throw new Error('Seed failed');
        const existing = initial.output.plan.rules.map((entry) => entry.rule);
        const original = existing[0];
        if (!original) throw new Error('Missing rule');
        const edit = validateCandidate(
            plan([{ ...quiz, replaceId: original.id, actions: original.actions }], []),
            {
                ...context,
                scene: { ...context.scene, interactions: existing },
                editor: { ...context.editor, variables: initial.output.plan.variables },
            },
        );
        if (!edit.ok || edit.output.status !== 'edit_plan') throw new Error(JSON.stringify(edit));
        expect(edit.output.plan.rules).toHaveLength(1);
        expect(edit.output.plan.rules[0]?.rule.id).toBe(original.id);
        expect(edit.output.plan.rules[0]?.rule.actions[0]).toEqual(original.actions[0]);
    });

    it.each([
        [plan([{ ...quiz, edges: quiz.edges.slice(0, -1) }]), 'nhánh'],
        [plan([{ ...quiz, trigger: { type: 'onPageLeave' } }]), 'rời trang'],
        [plan([quiz], [{ ...score, initialValue: false, type: 'boolean' }]), 'kiểu'],
        [
            plan([
                {
                    ...quiz,
                    actions: [
                        {
                            type: 'navigate',
                            navigation: {
                                target: 'page',
                                pageId: '22222222-2222-4222-8222-222222222222',
                            },
                        },
                    ],
                    edges: undefined,
                },
            ]),
            'thuộc sách',
        ],
        [
            plan([
                {
                    ...quiz,
                    actions: [{ type: 'openUrl', url: 'https://example.org/a' }],
                    edges: undefined,
                },
            ]),
            'tác giả nhập',
        ],
    ])('rejects unsafe or broken changes before returning a plan', (text, reason) => {
        const result = validateCandidate(text, context);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.join(' ')).toContain(reason);
    });
});
