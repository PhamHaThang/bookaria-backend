import { z } from 'zod';
import { AuthResponseSchema, AuthUserSchema, RefreshTokenResultSchema } from './api/auth.schema';
import { HealthDataSchema } from './common.schema';
import { ApiErrorSchema, ERROR_MESSAGES, type ErrorCode, HTTP_STATUS } from './error.schema';
import { type Route, routes } from './routes.schema';

/**
 * Dựng tài liệu OpenAPI 3.0 từ bảng `routes` (src/schema/routes.schema.ts). Không có gì viết tay cho từng
 * endpoint nên tài liệu không thể lệch với schema mà server dùng để kiểm tra dữ liệu.
 *
 * File này là hàm thuần (chỉ phụ thuộc zod và các file trong schema/): không đọc hay ghi file, nên chạy
 * được ở cả Node lẫn trình duyệt, và API có thể trả thẳng tài liệu lúc chạy. Việc ghi file nằm ở
 * src/scripts/build-openapi.ts (`pnpm docs:openapi`).
 */

type Json = Record<string, unknown>;
type Definitions = Record<string, Json>;

/** Schema dùng chung được đặt tên: thành `components.schemas`, nơi khác chỉ `$ref` tới. */
const NAMED: Record<string, z.ZodType> = {
    ApiError: ApiErrorSchema,
    AuthUser: AuthUserSchema,
    AuthResponse: AuthResponseSchema,
    RefreshTokenResult: RefreshTokenResultSchema,
    HealthData: HealthDataSchema,
};

function registerNames(): void {
    for (const [id, schema] of Object.entries(NAMED)) {
        if (!z.globalRegistry.has(schema)) z.globalRegistry.add(schema, { id });
    }
}

/** Chuyển một schema zod sang JSON Schema; các định nghĩa dùng chung được gom vào `defs`. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output', defs: Definitions): Json {
    const result = z.toJSONSchema(schema, {
        target: 'openapi-3.0',
        io,
        unrepresentable: 'any',
        // `format: uuid` là đủ; bỏ `pattern` dài cho tài liệu gọn.
        override: (ctx) => {
            if (ctx.jsonSchema.format === 'uuid') delete ctx.jsonSchema.pattern;
        },
    }) as Json;
    // OpenAPI không có từ khóa `$schema`; các định nghĩa dùng chung chuyển sang `components`.
    const { $schema: _ignored, definitions, $defs, ...rest } = result;
    for (const found of [definitions, $defs]) {
        if (found) Object.assign(defs, found as Definitions);
    }
    return rest;
}

/** `/books/:bookId` -> `/books/{bookId}` */
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

/** Tag = đoạn đầu của đường dẫn: `/auth/login` -> `auth`. */
const tagOf = (path: string) => path.split('/')[1] ?? 'misc';

function parametersOf(schema: z.ZodObject, where: 'path' | 'query', defs: Definitions) {
    const js = jsonSchema(schema, 'input', defs);
    const props = (js.properties ?? {}) as Record<string, Json>;
    const required = new Set((js.required ?? []) as string[]);
    return Object.entries(props).map(([name, s]) => ({
        name,
        in: where,
        required: where === 'path' || required.has(name),
        schema: s,
    }));
}

/**
 * Lỗi mà route nào cũng có thể trả tùy cách gọi. Lỗi riêng của từng route (RATE_LIMITED, EMAIL_TAKEN...)
 * khai báo ở `route.errors`: giới hạn tần suất áp dụng theo từng route nên không tự thêm cho mọi route.
 */
function commonErrors(route: Route): ErrorCode[] {
    const codes: ErrorCode[] = ['INTERNAL_ERROR'];
    if (route.params || route.query || route.body) codes.push('VALIDATION_ERROR');
    // Chỉ route dùng access token mới luôn có thể bị từ chối vì thiếu hay hết hạn. Route dùng cookie
    // (refresh, logout) tự khai báo lỗi ở `route.errors`: logout không bao giờ trả 401 (idempotent).
    if (route.access === 'author' || route.access === 'admin') {
        codes.push('UNAUTHENTICATED', 'TOKEN_EXPIRED');
    }
    if (route.access === 'admin') codes.push('FORBIDDEN');
    return codes;
}

/** Gom mã lỗi theo HTTP status để mỗi status chỉ xuất hiện một lần trong `responses`. */
function errorResponses(route: Route): Record<string, Json> {
    const codes = [...new Set([...(route.errors ?? []), ...commonErrors(route)])];
    const byStatus = new Map<number, ErrorCode[]>();
    for (const code of codes) {
        const status = HTTP_STATUS[code];
        byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
    }
    const out: Record<string, Json> = {};
    for (const [status, list] of [...byStatus].sort(([a], [b]) => a - b)) {
        out[String(status)] = {
            description: list.map((c) => `\`${c}\`: ${ERROR_MESSAGES[c]}`).join('\n'),
            content: {
                'application/json': {
                    schema: { $ref: '#/components/schemas/ApiError' },
                    examples: Object.fromEntries(
                        list.map((code) => [
                            code,
                            {
                                value: {
                                    error: {
                                        code,
                                        message: ERROR_MESSAGES[code],
                                        requestId: 'req_9d5c4cac5a9d',
                                    },
                                },
                            },
                        ]),
                    ),
                },
            },
        };
    }
    return out;
}

const SUCCESS_TEXT: Record<number, string> = {
    200: 'Thành công',
    201: 'Đã tạo',
    202: 'Đã nhận (công việc nền đã bắt đầu)',
    204: 'Thành công, không có nội dung',
};

const SECURITY: Record<Route['access'], Json[]> = {
    public: [],
    cookie: [{ cookieAuth: [] }],
    author: [{ bearerAuth: [] }],
    admin: [{ bearerAuth: [] }],
};

function operation(route: Route, defs: Definitions): Json {
    const parameters = [
        ...(route.params ? parametersOf(route.params, 'path', defs) : []),
        ...(route.query ? parametersOf(route.query, 'query', defs) : []),
    ];

    const responses: Record<string, Json> = {};
    for (const [status, schema] of Object.entries(route.responses)) {
        responses[status] = {
            description: SUCCESS_TEXT[Number(status)] ?? 'Thành công',
            ...(schema
                ? {
                      content: {
                          'application/json': { schema: jsonSchema(schema, 'output', defs) },
                      },
                  }
                : {}),
        };
    }

    return {
        operationId: route.id,
        tags: [tagOf(route.path)],
        summary: route.summary,
        security: SECURITY[route.access],
        ...(parameters.length ? { parameters } : {}),
        ...(route.body
            ? {
                  requestBody: {
                      required: true,
                      content: {
                          'application/json': { schema: jsonSchema(route.body, 'input', defs) },
                      },
                  },
              }
            : {}),
        responses: { ...responses, ...errorResponses(route) },
    };
}

export interface BuildOpenApiOptions {
    version?: string;
    /** Địa chỉ gốc của API (đã gồm tiền tố `/api/v1`). */
    serverUrl?: string;
}

export function buildOpenApi(options: BuildOpenApiOptions = {}): Json {
    registerNames();
    const defs: Definitions = {};
    const paths: Record<string, Record<string, Json>> = {};
    for (const route of routes) {
        const path = toOpenApiPath(route.path);
        const item = paths[path] ?? {};
        item[route.method.toLowerCase()] = operation(route, defs);
        paths[path] = item;
    }
    // Schema lỗi được mọi route tham chiếu, kể cả khi body của route không nhắc tới nó.
    jsonSchema(ApiErrorSchema, 'output', defs);

    const doc = {
        openapi: '3.0.3',
        info: {
            title: 'Bookaria API',
            version: options.version ?? '1.0.0',
            description:
                'API của Bookaria, sinh từ các schema zod trong `src/schema`. Thành công trả ' +
                '`{ "data": ... }`, lỗi luôn có dạng `ApiError`.\n\n' +
                'Xác thực: access token gửi qua header `Authorization: Bearer <token>`; refresh token nằm ' +
                'trong cookie `bk_refresh` (httpOnly) do server đặt khi đăng ký hoặc đăng nhập.',
        },
        servers: [
            { url: options.serverUrl ?? 'http://localhost:4000/api/v1', description: 'Local' },
        ],
        paths,
        components: {
            schemas: defs,
            securitySchemes: {
                bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
                cookieAuth: { type: 'apiKey', in: 'cookie', name: 'bk_refresh' },
            },
        },
    };
    // Zod ghi định nghĩa dùng chung ở `#/definitions/X`; OpenAPI giữ chúng ở `components.schemas`.
    return JSON.parse(
        JSON.stringify(doc)
            .replaceAll('#/definitions/', '#/components/schemas/')
            .replaceAll('#/$defs/', '#/components/schemas/'),
    ) as Json;
}
