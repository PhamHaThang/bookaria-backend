import type { CandidateCheck } from '../../src/modules/interaction-ai/generation';
import type { BenchmarkCase } from './cases';
export function evaluateBehavior(
    testCase: BenchmarkCase,
    check: CandidateCheck,
): Promise<{
    passed: boolean;
    reason: string;
    humanReviewRequired?: boolean;
    trigger?: unknown;
    actualTrace?: unknown;
    expectedTrace?: unknown;
}>;
