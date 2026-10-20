import { describe, expect, it } from 'vitest';
import { buildOpenApi } from '../../../schema/openapi';

type ResponseSpec = { content?: Record<string, { schema: Record<string, unknown> }> };
type Operation = { responses: Record<string, ResponseSpec> };
const doc = buildOpenApi() as { paths: Record<string, Record<string, Operation>> };
describe('preview API contract', () => {
    it('documents asynchronous creation as 202 and removes immediate 201', () => {
        const responses = doc.paths['/books/{bookId}/previews']?.post?.responses;
        expect(responses?.['202']).toBeDefined();
        expect(responses?.['201']).toBeUndefined();
        expect(responses?.['409']).toBeDefined();
    });
    it('documents binary groups while keeping JSON errors and manifest', () => {
        const responses = doc.paths['/public/previews/{token}/groups/{group}']?.get?.responses;
        expect(responses?.['200']?.content?.['application/octet-stream']?.schema).toMatchObject({
            type: 'string',
            format: 'binary',
        });
        expect(responses?.['404']?.content?.['application/json']).toBeDefined();
        expect(
            doc.paths['/public/previews/{token}']?.get?.responses['200']?.content?.[
                'application/json'
            ],
        ).toBeDefined();
    });
});
