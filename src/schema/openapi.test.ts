import { describe, expect, it } from 'vitest';
import { HTTP_STATUS } from './error.schema';
import { buildOpenApi } from './openapi';
import { routes } from './routes.schema';

type Json = Record<string, unknown>;
const doc = buildOpenApi() as {
    openapi: string;
    paths: Record<string, Record<string, Json>>;
    components: { schemas: Record<string, Json>; securitySchemes: Record<string, Json> };
};

const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

describe('buildOpenApi', () => {
    it('có đủ mọi route trong registry, mỗi operationId duy nhất', () => {
        const ids = operations.map((o) => o.op.operationId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.sort()).toEqual(routes.map((r) => r.id).sort());
    });

    it('đường dẫn dùng {param} thay cho :param', () => {
        expect(Object.keys(doc.paths).every((p) => !p.includes(':'))).toBe(true);
    });

    it('mọi $ref đều trỏ tới component có thật và không còn #/definitions hay #/$defs', () => {
        const text = JSON.stringify(doc);
        expect(text).not.toContain('#/definitions/');
        expect(text).not.toContain('#/$defs/');
        const refs = [...text.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map(
            (m) => m[1],
        );
        expect(refs.length).toBeGreaterThan(0);
        for (const name of refs) {
            expect(doc.components.schemas, `thiếu component ${name}`).toHaveProperty(
                name as string,
            );
        }
    });

    it('mã lỗi khai báo ở route xuất hiện đúng HTTP status', () => {
        for (const route of routes) {
            const op = operations.find((o) => o.op.operationId === route.id);
            const responses = op?.op.responses as Record<string, { description: string }>;
            for (const code of route.errors ?? []) {
                const entry = responses[String(HTTP_STATUS[code])];
                expect(entry, `${route.id} thiếu status của ${code}`).toBeDefined();
                expect(entry?.description).toContain(code);
            }
        }
    });

    it('route có đầu vào luôn có VALIDATION_ERROR, mọi route có INTERNAL_ERROR', () => {
        for (const route of routes) {
            const op = operations.find((o) => o.op.operationId === route.id);
            const responses = op?.op.responses as Record<string, unknown>;
            expect(responses['500']).toBeDefined();
            if (route.body || route.query || route.params) expect(responses['400']).toBeDefined();
        }
    });

    it('phân loại bảo mật theo access của route', () => {
        for (const route of routes) {
            const op = operations.find((o) => o.op.operationId === route.id);
            const security = op?.op.security as Json[];
            if (route.access === 'public') expect(security).toEqual([]);
            if (route.access === 'cookie') expect(security).toEqual([{ cookieAuth: [] }]);
            if (route.access === 'author') expect(security).toEqual([{ bearerAuth: [] }]);
        }
        expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
            'bearerAuth',
            'cookieAuth',
        ]);
    });
});
