import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobResultsSchema } from '../dto.schema';

describe('OPTIMIZE_ASSET result', () => {
    it('rejects invalid download sizes before the worker marks a job successful', () => {
        const result = { assetId: randomUUID(), meta: { downloadBytes: 'large' } };
        expect(JobResultsSchema.OPTIMIZE_ASSET.safeParse(result).success).toBe(false);
    });
});
