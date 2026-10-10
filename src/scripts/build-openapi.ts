import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildOpenApi } from '../schema/openapi';

/**
 * Ghi tài liệu OpenAPI ra file. Logic dựng tài liệu nằm ở src/schema/openapi.ts.
 * Chạy: `pnpm docs:openapi`. Kết quả import được thẳng vào Postman.
 */
const OUT = 'postman/specs/bookaria-api.openapi.json';

const spec = buildOpenApi();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Đã ghi ${OUT} (${Object.keys(spec.paths as object).length} đường dẫn)`);
