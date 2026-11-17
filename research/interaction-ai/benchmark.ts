import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { env } from '../../src/config/env';
import {
    type Attempt,
    type Complete,
    generateAttempt,
    generationMessages,
    PROMPT_VERSION,
    repairMessages,
} from '../../src/modules/interaction-ai/generation';
import { completeInteraction } from '../../src/modules/interaction-ai/provider';
import { type BenchmarkCase, cases } from './cases';
import { challengeCases } from './challenge-cases';
import { evaluateBehavior } from './evaluate.mjs';

export async function compareCase(testCase: BenchmarkCase, complete: Complete) {
    const messages = generationMessages(testCase.instruction, testCase.context);
    const first = await generateAttempt(complete, messages, testCase.context);
    const retry = first.check.ok
        ? first
        : await generateAttempt(complete, messages, testCase.context);
    const repair = first.check.ok
        ? first
        : await generateAttempt(complete, repairMessages(messages, first), testCase.context);
    const configurations = await Promise.all(
        (
            [
                ['A', first],
                ['B', retry],
                ['C', repair],
            ] as const
        ).map(async ([name, last]) => {
            const attempts = last === first ? [first] : [first, last];
            const tokens = (field: 'inputTokens' | 'outputTokens') =>
                attempts.some((attempt) => attempt.completion[field] === null)
                    ? null
                    : attempts.reduce((sum, attempt) => sum + (attempt.completion[field] ?? 0), 0);
            return {
                name,
                schemaAndCapabilityValid: last.check.ok,
                proposal: last.check.ok && last.check.output.status === 'proposal',
                behavior: await evaluateBehavior(testCase, last.check),
                calls: attempts.length,
                inputTokens: tokens('inputTokens'),
                outputTokens: tokens('outputTokens'),
                latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
            };
        }),
    );
    const uniqueAttempts: Attempt[] = [
        first,
        ...(retry === first ? [] : [retry]),
        ...(repair === first ? [] : [repair]),
    ];
    return {
        id: testCase.id,
        group: testCase.group,
        split: testCase.split,
        instruction: testCase.instruction,
        messages,
        first,
        retry: retry === first ? null : retry,
        repair: repair === first ? null : repair,
        configurations,
        uniqueCalls: uniqueAttempts.length,
    };
}

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export async function main(args: string[]) {
    const split = args.find((arg) => arg.startsWith('--split='))?.split('=')[1] ?? 'dev';
    const repeats = Number(args.find((arg) => arg.startsWith('--repeats='))?.split('=')[1] ?? '1');
    const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? '120');
    if (
        !['dev', 'test', 'challenge'].includes(split) ||
        !Number.isInteger(repeats) ||
        repeats < 1 ||
        repeats > 3 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 120
    )
        throw new Error('Use --split=dev|test|challenge --repeats=1..3 --limit=1..120');
    const corpus = split === 'challenge' ? challengeCases : cases;
    const selected = corpus.filter((item) => item.split === split).slice(0, limit);
    if (!args.includes('--run')) {
        console.log(
            JSON.stringify(
                {
                    mode: 'dry-run',
                    datasetStatus: 'draft-needs-human-review',
                    total: corpus.length,
                    selected: selected.length,
                    repeats,
                    maximumProviderCalls: selected.length * repeats * 3,
                    model: env.AI_MODEL || 'not-configured',
                    sendsRequests: false,
                },
                null,
                2,
            ),
        );
        return;
    }
    const output = args.find((arg) => arg.startsWith('--out='))?.slice(6);
    if (!output || !env.AI_MODEL || !env.AI_API_KEY)
        throw new Error(
            'Set AI_MODEL and AI_API_KEY on backend, and supply --out=<new-file.jsonl>.',
        );
    const files = [
        split === 'challenge' ? 'challenge-cases.ts' : 'cases.ts',
        'evaluate.mjs',
        '../../src/modules/interaction-ai/generation.ts',
        '../../src/modules/interaction-ai/provider.ts',
        '../../src/schema/api/interaction-ai.schema.ts',
        '../../../bookaria-viewer/src/scene-core/InteractionRunner.ts',
    ];
    const hashes = Object.fromEntries(
        await Promise.all(
            files.map(async (file) => [file, hash(await readFile(new URL(file, import.meta.url)))]),
        ),
    );
    const manifest = {
        type: 'manifest',
        startedAt: new Date().toISOString(),
        split,
        repeats,
        selected: selected.map((item) => item.id),
        datasetStatus: 'draft-needs-human-review',
        model: env.AI_MODEL,
        endpoint: new URL(env.AI_BASE_URL).origin,
        promptVersion: PROMPT_VERSION,
        hashes,
        parameters: {
            max_completion_tokens: 4096,
            response_format: { type: 'json_object' },
            timeoutMs: env.AI_TIMEOUT_MS,
        },
        node: process.version,
    };
    await writeFile(output, `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
    let completed = 0,
        uniqueCalls = 0;
    const totals = {
        A: { passed: 0, valid: 0 },
        B: { passed: 0, valid: 0 },
        C: { passed: 0, valid: 0 },
    };
    for (let repeat = 1; repeat <= repeats; repeat++)
        for (const item of selected) {
            try {
                const result = await compareCase(item, completeInteraction);
                await appendFile(
                    output,
                    `${JSON.stringify({ type: 'case', repeat, ...result })}\n`,
                );
                completed++;
                uniqueCalls += result.uniqueCalls;
                for (const configuration of result.configurations) {
                    if (configuration.behavior.passed) totals[configuration.name].passed++;
                    if (configuration.schemaAndCapabilityValid) totals[configuration.name].valid++;
                }
                console.log(`${completed}/${selected.length * repeats}: ${item.id}`);
            } catch {
                // A provider failure is a failed run, not an invalid model answer. Preserve partial evidence.
                await appendFile(
                    output,
                    `${JSON.stringify({ type: 'run_error', id: item.id, repeat, completed, planned: selected.length * repeats, message: 'Provider or evaluation failed; run incomplete. Token usage of interrupted calls is unknown.' })}\n`,
                );
                throw new Error(
                    'Benchmark stopped; partial evidence saved. Check provider/configuration. Do not treat this as a completed comparison.',
                );
            }
        }
    const summary = {
        type: 'summary',
        completed,
        planned: selected.length * repeats,
        uniqueCalls,
        totals,
        note: 'Group paraphrases/repeats for statistical analysis. Token cost is not an invoice; review raw usage and current pricing. Negative-response wording requires human review.',
    };
    await appendFile(output, `${JSON.stringify(summary)}\n`);
    console.log(JSON.stringify(summary, null, 2));
}
