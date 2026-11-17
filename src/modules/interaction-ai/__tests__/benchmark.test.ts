import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { compareCase } from '../../../../research/interaction-ai/benchmark';
import { cases } from '../../../../research/interaction-ai/cases';
import { challengeCases } from '../../../../research/interaction-ai/challenge-cases';
import { evaluateBehavior } from '../../../../research/interaction-ai/evaluate.mjs';
import { validateCandidate } from '../generation';

// Backend CI checks this repo alone; real-runtime checks also run in the three-repo workspace.
const hasViewer = existsSync(
    new URL('../../../../../bookaria-viewer/src/scene-core/InteractionRunner.ts', import.meta.url),
);

describe('benchmark infrastructure (synthetic self-check, not model results)', () => {
    it('has 120 tasks, group-disjoint splits and three phrasings per scenario', () => {
        expect(cases).toHaveLength(120);
        expect(cases.filter((item) => item.split === 'dev')).toHaveLength(30);
        const devGroups = new Set(
            cases.filter((item) => item.split === 'dev').map((item) => item.group),
        );
        expect(
            cases
                .filter((item) => item.split === 'test')
                .every((item) => !devGroups.has(item.group)),
        ).toBe(true);
        expect(new Set(cases.map((item) => item.id)).size).toBe(120);
        expect(new Set(cases.map((item) => item.group)).size).toBe(40);
    });
    it('all authored expected outputs pass schema and capability checks', () => {
        for (const item of [...cases, ...challengeCases]) {
            const raw =
                item.expected.status === 'proposal'
                    ? {
                          status: 'proposal',
                          rule: {
                              name: 'Expected fixture',
                              trigger: item.expected.trigger,
                              actions: item.expected.actions,
                          },
                      }
                    : { status: item.expected.status, message: 'Fixture only' };
            const check = validateCandidate(JSON.stringify(raw), item.context);
            expect(check.ok, item.id).toBe(true);
        }
    });
    it('keeps the new challenge groups and page contexts separate from the original corpus', () => {
        const originalGroups = new Set(cases.map(({ group }) => group));
        const originalObjects = new Set(
            cases.flatMap(({ context }) => context.scene.objects.map(({ id }) => id)),
        );
        expect(challengeCases).toHaveLength(24);
        expect(new Set(challengeCases.map(({ id }) => id)).size).toBe(24);
        expect(new Set(challengeCases.map(({ group }) => group)).size).toBe(8);
        for (const item of challengeCases) {
            expect(item.split).toBe('challenge');
            expect(originalGroups.has(item.group)).toBe(false);
            expect(item.context.scene.objects.some(({ id }) => originalObjects.has(id))).toBe(
                false,
            );
        }
    });
    it.skipIf(!hasViewer)(
        'all authored expected outputs pass independent runtime checks',
        async () => {
            for (const item of [...cases, ...challengeCases]) {
                const raw =
                    item.expected.status === 'proposal'
                        ? {
                              status: 'proposal',
                              rule: {
                                  name: 'Fixture',
                                  trigger: item.expected.trigger,
                                  actions: item.expected.actions,
                              },
                          }
                        : { status: item.expected.status, message: 'Fixture only' };
                const check = validateCandidate(JSON.stringify(raw), item.context);
                expect((await evaluateBehavior(item, check)).passed, item.id).toBe(true);
            }
        },
    );
    it.skipIf(!hasViewer)(
        'detects wrong trigger, target, ordering and wait even when JSON passes validators',
        async () => {
            const item = cases.find((entry) => entry.group === 'test-narrated-card');
            if (item?.expected.status !== 'proposal') throw new Error('missing fixture');
            const base = {
                name: 'Fixture',
                trigger: item.expected.trigger,
                actions: item.expected.actions,
            };
            const variants = [
                { ...base, trigger: { type: 'onPageEnter' } },
                {
                    ...base,
                    actions: base.actions.map((a) =>
                        a.type === 'setVisible' ? { ...a, objectId: 'hint' } : a,
                    ),
                },
                { ...base, actions: [...base.actions].reverse() },
                {
                    ...base,
                    actions: base.actions.map((a) => (a.type === 'wait' ? { ...a, ms: 100 } : a)),
                },
            ];
            for (const rule of variants) {
                const check = validateCandidate(
                    JSON.stringify({ status: 'proposal', rule }),
                    item.context,
                );
                expect(check.ok).toBe(true);
                expect((await evaluateBehavior(item, check)).passed).toBe(false);
            }
        },
    );
    it('shares first output, retries B without feedback and repairs C with exact validation errors', async () => {
        const item = cases.find((entry) => entry.group === 'test-navigation');
        if (!item) throw new Error('fixture');
        const good = JSON.stringify({
            status: 'unsupported',
            message: 'Chuyển trang nằm ngoài phạm vi trợ lý v1.',
        });
        const complete = vi
            .fn()
            .mockResolvedValueOnce({
                text: 'not json',
                model: 'fake',
                inputTokens: 10,
                outputTokens: 2,
            })
            .mockResolvedValue({ text: good, model: 'fake', inputTokens: 20, outputTokens: 10 });
        const result = await compareCase(item, complete);
        expect(complete).toHaveBeenCalledTimes(3);
        expect(complete.mock.calls[0]?.[0]).toEqual(complete.mock.calls[1]?.[0]);
        expect(complete.mock.calls[2]?.[0]).toHaveLength(4);
        expect(result.configurations.map((config) => config.behavior.passed)).toEqual([
            false,
            true,
            true,
        ]);
        expect(result.configurations.map((config) => config.calls)).toEqual([1, 2, 2]);
    });
});
