import { z } from 'zod';
import { AuthResponseSchema, AuthUserSchema, RefreshTokenResultSchema } from './api/auth.schema';
import { AssetMetaSchema, AssetRefSchema, ManifestAssetSchema } from './asset.schema';
import { HealthDataSchema } from './common.schema';
import {
    AdminUserSchema,
    AssetCategorySchema,
    AssetSchema,
    AuditLogSchema,
    BookariaMarkerSchema,
    BookDetailSchema,
    BookSummarySchema,
    JobSchema,
    MeSchema,
    ModerationItemSchema,
    NotificationSchema,
    PageSchema,
    PageSummarySchema,
    PublicBookSchema,
    UserRefSchema,
    VersionSchema,
} from './dto.schema';
import { ApiErrorSchema, ERROR_MESSAGES, type ErrorCode, HTTP_STATUS } from './error.schema';
import {
    ManifestCreditSchema,
    ManifestGroupSchema,
    ManifestMarkerSchema,
    ManifestPageSchema,
    ManifestSchema,
} from './manifest.schema';
import {
    BookariaMarkerPlacementSchema,
    MarkerReportSchema,
    MarkerTransformSchema,
} from './marker.schema';
import { type Route, routes } from './routes.schema';
import {
    ActionSchema,
    InteractionRuleSchema,
    PageSettingsSchema,
    PublishedSceneSchema,
    SceneObjectSchema,
    SceneSchema,
    SceneWarningSchema,
} from './scene.schema';

/**
 * Dựng tài liệu OpenAPI 3.0 từ bảng `routes` (src/schema/routes.schema.ts). Không có gì viết tay cho từng
 * endpoint nên tài liệu không thể lệch với schema mà server dùng để kiểm tra dữ liệu.
 *
 * File này là hàm thuần (chỉ phụ thuộc zod và các file trong schema/): không đọc hay ghi file, nên chạy
 * được ở cả Node lẫn trình duyệt, và API có thể trả thẳng tài liệu lúc chạy. Việc ghi file nằm ở
 * src/scripts/build-openapi.ts (`pnpm contract:sync`).
 *
 * Các schema lớn dùng chung được đặt tên (`components.schemas`) để tài liệu gọn: `Scene`, `Page`, `Manifest`...
 * Cùng một schema có thể có dạng request (input) khác dạng response (output) vì giá trị mặc định
 * (`.default()`), nên khi hai dạng khác nhau chúng được tách thành `X` (response) và `XInput` (request).
 */

type Json = Record<string, unknown>;
type Definitions = Record<string, Json>;

/** Schema dùng chung được đặt tên: thành `components.schemas`, nơi khác chỉ `$ref` tới. */
const NAMED: Record<string, z.ZodType> = {
    // Chung
    ApiError: ApiErrorSchema,
    HealthData: HealthDataSchema,
    // Auth
    AuthUser: AuthUserSchema,
    AuthResponse: AuthResponseSchema,
    RefreshTokenResult: RefreshTokenResultSchema,
    // Người dùng, sách, trang, tài nguyên
    UserRef: UserRefSchema,
    Me: MeSchema,
    AdminUser: AdminUserSchema,
    BookSummary: BookSummarySchema,
    BookDetail: BookDetailSchema,
    PageSummary: PageSummarySchema,
    Page: PageSchema,
    Asset: AssetSchema,
    AssetCategory: AssetCategorySchema,
    Job: JobSchema,
    Version: VersionSchema,
    Notification: NotificationSchema,
    PublicBook: PublicBookSchema,
    ModerationItem: ModerationItemSchema,
    AuditLog: AuditLogSchema,
    BookariaMarker: BookariaMarkerSchema,
    // Cảnh (scene) và marker
    Scene: SceneSchema,
    PublishedScene: PublishedSceneSchema,
    SceneObject: SceneObjectSchema,
    InteractionRule: InteractionRuleSchema,
    Action: ActionSchema,
    PageSettings: PageSettingsSchema,
    SceneWarning: SceneWarningSchema,
    MarkerTransform: MarkerTransformSchema,
    MarkerReport: MarkerReportSchema,
    BookariaMarkerPlacement: BookariaMarkerPlacementSchema,
    // Manifest và tài nguyên
    Manifest: ManifestSchema,
    ManifestPage: ManifestPageSchema,
    ManifestGroup: ManifestGroupSchema,
    ManifestMarker: ManifestMarkerSchema,
    ManifestCredit: ManifestCreditSchema,
    ManifestAsset: ManifestAssetSchema,
    AssetMeta: AssetMetaSchema,
    AssetRef: AssetRefSchema,
};

function registerNames(): void {
    for (const [id, schema] of Object.entries(NAMED)) {
        if (!z.globalRegistry.has(schema)) z.globalRegistry.add(schema, { id });
    }
}

/** Đánh dấu `$ref` đến từ dạng request để phân biệt với dạng response khi gom component. */
const IN = '__in__';
const REF = /#\/(?:definitions|\$defs)\/(__in__)?([A-Za-z0-9_]+)/g;
const markInput = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value).replace(REF, `#/definitions/${IN}$2`)) as T;

/**
 * Chuyển một schema zod sang JSON Schema. Các định nghĩa dùng chung được gom vào `defs`
 * (dạng request và dạng response ở hai bảng riêng, xem `buildOpenApi`).
 */
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
    const found: Definitions = {
        ...((definitions as Definitions | undefined) ?? {}),
        ...(($defs as Definitions | undefined) ?? {}),
    };
    if (io === 'input') {
        for (const [name, def] of Object.entries(found)) defs[name] = markInput(def);
        return markInput(rest);
    }
    Object.assign(defs, found);
    return rest;
}

/** `/books/:bookId` -> `/books/{bookId}` */
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

/** Tag = đoạn đầu của đường dẫn: `/auth/login` -> `auth`. */
const tagOf = (path: string) => path.split('/')[1] ?? 'misc';

function parametersOf(schema: z.ZodObject, where: 'path' | 'query', inDefs: Definitions) {
    const js = jsonSchema(schema, 'input', inDefs);
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
        codes.push('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'ACCOUNT_LOCKED');
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
                    schema: { $ref: '#/definitions/ApiError' },
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

function operation(route: Route, inDefs: Definitions, outDefs: Definitions): Json {
    const parameters = [
        ...(route.params ? parametersOf(route.params, 'path', inDefs) : []),
        ...(route.query ? parametersOf(route.query, 'query', inDefs) : []),
    ];

    const responses: Record<string, Json> = {};
    for (const [status, schema] of Object.entries(route.responses)) {
        responses[status] = {
            description: SUCCESS_TEXT[Number(status)] ?? 'Thành công',
            ...(schema
                ? {
                      content: {
                          [route.responseContentType ?? 'application/json']: {
                              schema: jsonSchema(schema, 'output', outDefs),
                          },
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
                          'application/json': { schema: jsonSchema(route.body, 'input', inDefs) },
                      },
                  },
              }
            : {}),
        responses: { ...responses, ...errorResponses(route) },
    };
}

/** Tên các component mà một định nghĩa tham chiếu tới (bỏ dấu `__in__`). */
const refsOf = (def: Json): string[] =>
    [...JSON.stringify(def).matchAll(REF)].map((m) => m[2] as string);

/**
 * Tên component phải tách thành `X` và `XInput`: dạng request khác dạng response, hoặc tham chiếu
 * (trực tiếp hay gián tiếp) tới một component như vậy.
 */
function splitNames(inDefs: Definitions, outDefs: Definitions): Set<string> {
    const normalize = (def: Json) => JSON.stringify(def).replaceAll(IN, '');
    const split = new Set<string>();
    for (const name of Object.keys(inDefs)) {
        const out = outDefs[name];
        if (out && normalize(inDefs[name] as Json) !== normalize(out)) split.add(name);
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const name of Object.keys(inDefs)) {
            if (split.has(name) || !outDefs[name]) continue;
            const deps = [...refsOf(inDefs[name] as Json), ...refsOf(outDefs[name] as Json)];
            if (deps.some((d) => split.has(d))) {
                split.add(name);
                changed = true;
            }
        }
    }
    return split;
}

export interface BuildOpenApiOptions {
    version?: string;
    /** Địa chỉ gốc của API (đã gồm tiền tố `/api/v1`). */
    serverUrl?: string;
}

export function buildOpenApi(options: BuildOpenApiOptions = {}): Json {
    registerNames();
    const inDefs: Definitions = {};
    const outDefs: Definitions = {};
    const paths: Record<string, Record<string, Json>> = {};
    for (const route of routes) {
        const path = toOpenApiPath(route.path);
        const item = paths[path] ?? {};
        item[route.method.toLowerCase()] = operation(route, inDefs, outDefs);
        paths[path] = item;
    }
    // Schema lỗi được mọi route tham chiếu, kể cả khi body của route không nhắc tới nó.
    jsonSchema(ApiErrorSchema, 'output', outDefs);

    const split = splitNames(inDefs, outDefs);
    const schemas: Definitions = { ...outDefs };
    for (const [name, def] of Object.entries(inDefs)) {
        if (split.has(name)) schemas[`${name}Input`] = def;
        else if (!(name in outDefs)) schemas[name] = def;
    }

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
            schemas,
            securitySchemes: {
                bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
                cookieAuth: { type: 'apiKey', in: 'cookie', name: 'bk_refresh' },
            },
        },
    };
    // `#/definitions/X` -> `#/components/schemas/X`; ref từ dạng request tới component đã tách thì thêm `Input`.
    return JSON.parse(
        JSON.stringify(doc).replace(
            REF,
            (_m, fromInput: string | undefined, name: string) =>
                `#/components/schemas/${fromInput && split.has(name) ? `${name}Input` : name}`,
        ),
    ) as Json;
}
