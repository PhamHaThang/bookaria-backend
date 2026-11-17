import { isDeepStrictEqual } from 'node:util';
import { InteractionRuleSchema } from '../../src/schema/scene.schema.ts';

// Real event/sequence runner, virtual clock and effect executor; rendering/media are tested in the browser.
async function trace(rule, context, trigger) {
    const { InteractionRunner } = await import(
        new URL('../../../bookaria-viewer/src/scene-core/InteractionRunner.ts', import.meta.url)
            .href
    );
    let clock = 0;
    const effects = [],
        errors = [];
    const visible = new Map(context.scene.objects.map((object) => [object.id, object.visible]));
    const transforms = new Map(
        context.scene.objects.map((object) => [object.id, structuredClone(object.transform)]),
    );
    const runner = new InteractionRunner(
        [rule],
        async (action) => {
            const { delayMsSchema: _delay, ...effect } = action;
            if (action.type === 'setVisible' || action.type === 'toggleVisible') {
                const value =
                    action.type === 'setVisible' ? action.value : !visible.get(action.objectId);
                effects.push({
                    at: clock,
                    type: 'setVisible',
                    objectId: action.objectId,
                    value,
                    durationMs: action.durationMs,
                });
                visible.set(action.objectId, value);
                clock += action.durationMs;
            } else if (action.type === 'transformTo') {
                const previous = transforms.get(action.objectId);
                const target = {
                    position: action.position ?? previous.position,
                    rotation: action.rotation ?? previous.rotation,
                    scale: action.scale ?? previous.scale,
                };
                transforms.set(action.objectId, target);
                effects.push({
                    at: clock,
                    type: action.type,
                    objectId: action.objectId,
                    ...target,
                    durationMs: action.durationMs,
                    easing: action.easing,
                });
                clock += action.durationMs;
            } else {
                effects.push({ at: clock, ...effect });
            }
        },
        (error) => errors.push(error),
        async (ms) => {
            clock += ms;
        },
    );
    try {
        // Concurrent activation must not duplicate an ignore-on-retrigger rule.
        await Promise.all([runner.fire(trigger), runner.fire(trigger)]);
        return JSON.parse(
            JSON.stringify(
                { effects, clock, errors, visible: [...visible], transforms: [...transforms] },
                (_key, value) =>
                    typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value,
            ),
        );
    } finally {
        runner.dispose();
    }
}

export async function evaluateBehavior(testCase, check) {
    if (!check.ok) return { passed: false, reason: 'invalid_output' };
    if (testCase.expected.status !== 'proposal') {
        return {
            passed: check.output.status === testCase.expected.status,
            reason: 'response_status',
            humanReviewRequired: true,
        };
    }
    if (check.output.status !== 'proposal') return { passed: false, reason: 'no_proposal' };
    const expected = InteractionRuleSchema.parse({
        id: 'expected',
        enabled: true,
        onRetrigger: 'ignore',
        trigger: testCase.expected.trigger,
        actions: testCase.expected.actions,
    });
    const triggers = [
        { type: 'onPageEnter' },
        { type: 'onPageLeave' },
        ...testCase.context.scene.objects
            .filter((object) => object.type !== 'audio')
            .map((object) => ({ type: 'onTap', objectId: object.id })),
    ];
    for (const trigger of triggers) {
        const actualTrace = await trace(check.output.rule, testCase.context, trigger);
        const expectedTrace = await trace(expected, testCase.context, trigger);
        if (!isDeepStrictEqual(actualTrace, expectedTrace))
            return {
                passed: false,
                reason: 'behavior_mismatch',
                trigger,
                actualTrace,
                expectedTrace,
            };
    }
    return { passed: true, reason: 'behavior_match' };
}
