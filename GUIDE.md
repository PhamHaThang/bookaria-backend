# Hướng dẫn viết backend Bookaria

Tài liệu này dành cho thành viên của nhóm: chưa biết codebase này.
Đọc xong tài liệu sẽ hiểu một request đi qua những gì, mỗi lớp làm việc gì, và thêm một endpoint mới theo
đúng quy ước của dự án. Cài đặt và chạy dự án nằm ở [README.md](README.md); file này tập trung vào
**cách viết code**.

## Mục lục
1. [Tổng quan](#1-tổng-quan)
2. [Cấu trúc thư mục](#2-cấu-trúc-thư-mục)
3. [Một request đi qua những gì](#3-một-request-đi-qua-những-gì)
4. [Quy ước chung](#4-quy-ước-chung)
5. [Thêm một endpoint, từng bước](#5-thêm-một-endpoint-từng-bước)
6. [Các chủ đề thường gặp](#6-các-chủ-đề-thường-gặp)
7. [Kiểm thử](#7-kiểm-thử)
8. [Trước khi tạo PR](#8-trước-khi-tạo-pr)
9. [Lỗi thường gặp](#9-lỗi-thường-gặp)

---

## 1. Tổng quan

| Thành phần | Công nghệ |
|---|---|
| Runtime, ngôn ngữ | Node.js 22, TypeScript (ESM) |
| Web | Express 5 |
| Cơ sở dữ liệu | PostgreSQL 16 (`pg`, SQL thuần, không dùng ORM) |
| Migration | `node-pg-migrate` (file `.sql`) |
| Kiểm tra dữ liệu | `zod` 4 |
| Xác thực | JWT access token + refresh token trong cookie |
| Test | Vitest + Supertest, Postgres thật |
| Lint, định dạng | Biome |
| Quản lý gói | pnpm |

Ba ý tưởng chi phối cách viết code ở đây:

1. **Hợp đồng trước (contract-first).** Hình dạng request, response và danh sách route nằm trong
   `src/schema/` và là nguồn sự thật. Server dùng đúng các schema đó để kiểm tra dữ liệu, và tài liệu
   OpenAPI được sinh ra từ đó. FE có thể dùng chung `schema/`.
2. **Mỗi lớp một việc, chỉ phụ thuộc xuống dưới.** Route, controller, service, repository.
3. **Lỗi là dữ liệu có mã ổn định.** Mọi lỗi trả về dạng `{ error: { code, message, ... } }`, `code` do
   `ErrorCode` định nghĩa; client xử lý theo `code`, không theo câu chữ.

---

## 2. Cấu trúc thư mục

```
src/
├─ main.ts, app.ts          điểm vào API; createApp() lắp middleware và router
├─ config/                  env (zod), logger, danh sách origin CORS
├─ schema/                  HỢP ĐỒNG API: schema zod, mã lỗi, registry route, OpenAPI
│  ├─ api/*.schema.ts       body/query/params/response theo từng nhóm API
│  ├─ routes.schema.ts      registry: danh sách mọi route của API
│  └─ openapi.ts            dựng tài liệu OpenAPI từ registry
├─ db/                      pool, withTransaction, kiểu Queryable
├─ lib/                     nối ra thư viện hoặc dịch vụ ngoài: jwt, password, mailer
├─ utils/                   hàm thuần dùng chung: AppError, asyncHandler, response, pagination
├─ middlewares/             auth, rate limit, origin, error, request id
├─ modules/                 nghiệp vụ, mỗi tính năng một thư mục
│  ├─ auth/                 module mẫu: đọc cái này trước
│  └─ index.ts              createApiRouter(): gắn các module vào /api/v1
├─ scripts/                 seed, build-openapi (chạy bằng pnpm)
├─ test/                    cài đặt dùng chung cho test (global-setup)
└─ worker/                  điểm vào worker (hiện mới là khung)
migrations/                 file .sql theo thời gian
docker/                     docker-compose (Postgres, Mailpit)
postman/specs/              OpenAPI sinh tự động (đừng sửa tay)
```

### Trách nhiệm từng lớp

| Lớp | Được làm | Không được làm |
|---|---|---|
| `*.routes.ts` | Khai báo đường dẫn, gắn middleware (rate limit, auth) và controller | Chứa nghiệp vụ |
| `*.controller.ts` | Đọc `req`, gọi service, trả response (`ok`, `paginated`...) | Viết SQL, quyết định nghiệp vụ |
| `*.service.ts` | Nghiệp vụ, điều phối repository, quản lý transaction, ném `AppError` | Biết về Express (`req`, `res`) |
| `*.repository.ts` | Chỉ SQL, nhận `db` ở tham số đầu, trả về hàng dữ liệu | Quyết định nghiệp vụ, ném `AppError` |
| `schema/` | Schema zod, mã lỗi, registry route | Import `express`, `pg`, `config` (chỉ import `zod`) |

### Quy tắc phụ thuộc

```
routes → controller → service → repository → db
                         └──→ lib (jwt, password, mailer)
schema ← mọi tầng đều import, nhưng schema không import ai (chỉ zod)
```
- Chỉ đi xuống, không import ngược.
- Module này **không** import repository của module kia. Cần dữ liệu của module khác thì gọi
  **service** của nó.
- `utils/` là hàm thuần, không đọc `env`. Cái gì cần `env` hay nối ra dịch vụ ngoài thì ở `lib/`.

---

## 3. Một request đi qua những gì

```
Client
  │
  ▼  app.ts (theo đúng thứ tự)
requestId → pino-http (log, ẩn authorization/cookie) → helmet → cors
  → express.json → urlencoded → cookieParser
  │
  ▼  /api/v1  →  modules/index.ts  →  <module>.routes.ts
[rateLimit] → [requireAuth] → controller (tự parse dữ liệu vào bằng schema)
  │
  ▼
controller  →  service  →  repository  →  PostgreSQL
  │
  ▼
ok() / created() / paginated() / noContent()          (thành công)
throw AppError / ZodError  →  errorMiddleware         (lỗi: luôn cùng một dạng)
```

- Thứ tự middleware trong route quan trọng: **rate limit trước** (chặn sớm, đỡ tốn CPU bcrypt), rồi
  xác thực; việc validate dữ liệu làm ngay đầu controller.
- `asyncHandler` bọc controller để `throw` hoặc `reject` được chuyển cho `errorMiddleware`.
- Mọi request có `requestId` (header `X-Request-Id`, có trong body lỗi): dùng nó để tra log.

---

## 4. Quy ước chung

### Đặt tên file
| Vai trò | Mẫu | Ví dụ |
|---|---|---|
| Route | `<module>.routes.ts` | `auth.routes.ts` |
| Controller | `<module>.controller.ts` | `auth.controller.ts` |
| Service | `<module>.service.ts` | `auth.service.ts` |
| Repository | `<module>.repository.ts` | `auth.repository.ts` |
| Hằng số riêng của module | `<module>.constants.ts` | `auth.constants.ts` |
| Schema | `<nhóm>.schema.ts` | `api/books.schema.ts` |
| Test | `<tên>.test.ts` cạnh file nguồn | `auth.test.ts` |

### Đặt tên trong code
- Schema zod có hậu tố `Schema` (`LoginBodySchema`); kiểu suy ra **cùng tên không hậu tố**
  (`type LoginBody = z.infer<typeof LoginBodySchema>`).
- Controller, service, repository là **đối tượng gom hàm**: `authController`, `authService`,
  `authRepository`. Hàm tiện ích riêng lẻ thì để rời (`hashPassword`).
- Cột DB `snake_case`, JSON trả ra client `camelCase`. Chuyển đổi ở service (`toBookSummary`).

### Import
- Đường dẫn tương đối, **không** thêm đuôi `.js`, **không** thêm `/index`
  (`from '../../utils'`, không phải `'../../utils/index.js'`).
- `schema/` chỉ import `zod` và các file trong `schema/`.

### Ngôn ngữ
- Thông báo trả cho người dùng, comment, log: **tiếng Việt**.
- Tên biến, hàm, mã lỗi (`ErrorCode`): **tiếng Anh**.
- Commit message: **tiếng Anh**, theo kiểu `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test: ...`.

### Đừng
- Ghép chuỗi người dùng gửi vào SQL. Luôn dùng tham số (`$1`, `$2`). Với `ORDER BY`, ánh xạ giá trị
  cho phép sang đoạn SQL cố định (xem mục 5).
- Log mật khẩu, token, cookie.
- Trả `passwordHash` hay hàng DB thô ra client. Luôn chuyển qua hàm `toXxx` rõ ràng.
- Sửa một migration đã chạy. Tạo migration mới (xem mục 6.7).

---

## 5. Thêm một endpoint, từng bước

Ví dụ xuyên suốt: **`GET /books`**, danh sách sách của tôi, có tìm kiếm, lọc theo trạng thái, sắp
xếp và phân trang. Route này đã có trong registry, bạn chỉ cần cài đặt phía server.

### Bước 0. Hợp đồng đã có chưa?

Mở `src/schema/routes.schema.ts` và tìm route:

```ts
{
    id: 'getBooks',
    method: 'GET',
    path: '/books',
    access: 'author',                       // public | cookie | author | admin
    summary: 'Sách của tôi: `?q`, `?status`, `?sort`, `?page`',
    query: ListBooksQuerySchema,            // schema zod ở schema/api/books.schema.ts
    responses: { 200: pagedResponse(BookSummarySchema) },
}
```

Nếu route **chưa có**, hãy thêm trước (schema trong `schema/api/*.schema.ts`, rồi khai báo ở registry)
và cho FE biết. Tuyệt đối không tự định nghĩa schema request/response ngay trong module.

### Bước 1. Migration (chỉ khi cần bảng hoặc cột mới)

```bash
pnpm db:new them-cot-abc       # tạo migrations/<thời gian>_them-cot-abc.sql
```
Viết `-- Up Migration` và `-- Down Migration`, rồi `pnpm db:migrate`. Quy tắc ở mục 6.7. Ở ví dụ
này bảng `books` và `pages` đã có.

### Bước 2. Repository: chỉ SQL

`src/modules/books/books.repository.ts`

```ts
import type { Queryable } from '../../db';
import type { BookStatus, BookVisibility, ListBooksQuery } from '../../schema';

export interface BookRow {
    id: string;
    title: string;
    status: BookStatus;
    visibility: BookVisibility;
    taken_down: boolean;
    page_count: number;
    updated_at: Date;
}

/** Chỉ cho phép các giá trị đã liệt kê: KHÔNG bao giờ ghép chuỗi người dùng gửi vào câu SQL. */
const ORDER_BY: Record<ListBooksQuery['sort'], string> = {
    updatedAt: 'b.updated_at ASC',
    '-updatedAt': 'b.updated_at DESC',
    createdAt: 'b.created_at ASC',
    '-createdAt': 'b.created_at DESC',
    title: 'b.title ASC',
    '-title': 'b.title DESC',
};

const FILTER = `b.owner_id = $1 AND b.deleted_at IS NULL
    AND ($2::text IS NULL OR b.title ILIKE '%' || $2 || '%')
    AND ($3::book_status IS NULL OR b.status = $3)`;

type Filter = Pick<ListBooksQuery, 'q' | 'status'>;

export const bookRepository = {
    async listByOwner(
        db: Queryable,
        ownerId: string,
        filter: Filter & Pick<ListBooksQuery, 'sort'>,
        page: { limit: number; offset: number },
    ): Promise<BookRow[]> {
        const { rows } = await db.query<BookRow>(
            `SELECT b.id, b.title, b.status, b.visibility,
                    (b.taken_down_at IS NOT NULL) AS taken_down,
                    b.updated_at,
                    (SELECT count(*)::int FROM pages p WHERE p.book_id = b.id) AS page_count
               FROM books b
              WHERE ${FILTER}
              ORDER BY ${ORDER_BY[filter.sort]}, b.id
              LIMIT $4 OFFSET $5`,
            [ownerId, filter.q ?? null, filter.status ?? null, page.limit, page.offset],
        );
        return rows;
    },

    async countByOwner(db: Queryable, ownerId: string, filter: Filter): Promise<number> {
        const { rows } = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM books b WHERE ${FILTER}`,
            [ownerId, filter.q ?? null, filter.status ?? null],
        );
        return rows[0]?.count ?? 0;
    },
};
```

Điểm cần nhớ:
- **`db` luôn là tham số đầu.** Gọi ngoài transaction thì truyền `pool`; trong transaction thì truyền
  `client` của `withTransaction` (mục 6.4). Không có giá trị mặc định, để không quên.
- Hàm trả về **hàng DB** (`snake_case`), không trả ra client.
- Tham số `LIMIT`/`OFFSET`/lọc luôn dùng `$n`. `count(*)::int` vì `pg` trả `bigint` dạng chuỗi.
- `ORDER BY` thêm `b.id` để thứ tự ổn định giữa các trang.

### Bước 3. Service: nghiệp vụ

`src/modules/books/books.service.ts`

```ts
import { pool } from '../../db';
import type { BookSummary, ListBooksQuery } from '../../schema';
import { toOffset } from '../../utils';
import { type BookRow, bookRepository } from './books.repository';

function toBookSummary(row: BookRow): BookSummary {
    return {
        id: row.id,
        title: row.title,
        coverUrl: null, // sẽ lấy từ asset khi làm module assets
        status: row.status,
        visibility: row.visibility,
        takenDown: row.taken_down,
        pageCount: row.page_count,
        updatedAt: row.updated_at.toISOString(),
    };
}

export const bookService = {
    async list(
        ownerId: string,
        query: ListBooksQuery,
    ): Promise<{ items: BookSummary[]; total: number }> {
        const [rows, total] = await Promise.all([
            bookRepository.listByOwner(pool, ownerId, query, toOffset(query)),
            bookRepository.countByOwner(pool, ownerId, query),
        ]);
        return { items: rows.map(toBookSummary), total };
    },
};
```

- Service **không import Express**. Nó nhận dữ liệu thường và trả dữ liệu thường.
- Chuyển hàng DB sang kiểu của hợp đồng (`BookSummary`) ở đây.
- Cần báo lỗi nghiệp vụ: `throw new AppError('NOT_FOUND', 'Không tìm thấy sách')` (mục 6.1).

### Bước 4. Controller: nối HTTP với service

`src/modules/books/books.controller.ts`

```ts
import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import { ListBooksQuerySchema } from '../../schema';
import { asyncHandler, buildPaginationMeta, paginated } from '../../utils';
import { bookService } from './books.service';

export const bookController = {
    list: asyncHandler(async (req: Request, res: Response) => {
        const query = ListBooksQuerySchema.parse(req.query);
        const { items, total } = await bookService.list(getAuth(res).userId, query);
        paginated(res, items, buildPaginationMeta(query, total));
    }),
};
```

- Dữ liệu vào được parse **ngay đầu controller** bằng schema (`Schema.parse(req.body)` hoặc
  `req.query`). Sai thì `ZodError` tự thành `400 VALIDATION_ERROR`, không cần bắt.
- `getAuth(res)` lấy người dùng hiện tại (do `requireAuth` gắn vào).
- Controller **mỏng**: không có `if` nghiệp vụ.

### Bước 5. Route và gắn vào API

`src/modules/books/books.routes.ts`

```ts
import { Router } from 'express';
import { requireAuth } from '../../middlewares';
import { bookController } from './books.controller';

export const bookRouter = () => {
    const router = Router();
    router.get('/', requireAuth, bookController.list);
    return router;
};
```

Gắn vào `src/modules/index.ts`:

```ts
router.use('/books', bookRouter());
```

Nếu route cần rate limit (đăng nhập, gửi email...), xem `auth.routes.ts` để lấy mẫu: nhận
`{ rateLimit: boolean }` từ `createApiRouter` và tạo bộ giới hạn bằng `rateLimitMiddleware`.

### Bước 6. Test

`src/modules/books/books.test.ts`

```ts
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { pool } from '../../db';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp();

suite('GET /books', () => {
    let token = '';

    beforeAll(async () => {
        const email = `u${Date.now().toString(36)}@example.com`;
        const res = await request(app)
            .post('/api/v1/auth/register')
            .send({ email, password: 'Matkhau-123', displayName: 'An' });
        token = res.body.data.accessToken;
        const userId = res.body.data.user.id;
        await pool.query(
            `INSERT INTO books (owner_id, title) VALUES ($1, 'Truyện A'), ($1, 'Truyện B')`,
            [userId],
        );
    });

    it('trả danh sách của chính mình kèm meta phân trang', async () => {
        const res = await request(app)
            .get('/api/v1/books?limit=1')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });
    });

    it('chưa đăng nhập thì 401', async () => {
        expect((await request(app).get('/api/v1/books')).status).toBe(401);
    });

    it('query sai thì 400 VALIDATION_ERROR', async () => {
        const res = await request(app)
            .get('/api/v1/books?limit=1000')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});
```
Test luôn có các ca: thành công, chưa đăng nhập (401), dữ liệu sai (400), không đủ quyền hoặc không
thấy (403/404). Chi tiết ở mục 7.

### Bước 7. Cập nhật tài liệu và kiểm tra

```bash
pnpm contract:sync     # nếu bạn sửa registry hoặc schema: sinh lại postman/specs/*.json
pnpm check             # biome + typecheck + test
```

### Tóm tắt

| # | Việc | File |
|---|---|---|
| 0 | Hợp đồng (schema + registry) | `schema/api/*.schema.ts`, `schema/routes.schema.ts` |
| 1 | Migration nếu cần | `migrations/*.sql` |
| 2 | SQL | `modules/<m>/<m>.repository.ts` |
| 3 | Nghiệp vụ | `modules/<m>/<m>.service.ts` |
| 4 | HTTP | `modules/<m>/<m>.controller.ts` |
| 5 | Route và gắn vào API | `modules/<m>/<m>.routes.ts`, `modules/index.ts` |
| 6 | Test | `modules/<m>/<m>.test.ts` |
| 7 | Tài liệu, kiểm tra | `pnpm contract:sync`, `pnpm check` |

---

## 6. Các chủ đề thường gặp

### 6.1 Báo lỗi

Ném `AppError` với một `ErrorCode`. Mã quyết định HTTP status; thông báo mặc định lấy từ
`ERROR_MESSAGES`, bạn có thể truyền câu riêng.

```ts
import { AppError } from '../../utils';

throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
throw new AppError('RATE_LIMITED', 'Vui lòng đợi', { retryAfterSeconds: 60 }); // details
```

Response lỗi luôn có dạng:

```json
{ "error": { "code": "NOT_FOUND", "message": "Không tìm thấy sách", "requestId": "req_..." } }
```

Một số mã hay gặp (đầy đủ ở `src/schema/error.schema.ts`):

| Mã | HTTP | Khi nào |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Dữ liệu sai (tự động, do `Schema.parse` trong controller) |
| `UNAUTHENTICATED` | 401 | Thiếu hoặc sai access token |
| `TOKEN_EXPIRED` | 401 | Access token hết hạn |
| `FORBIDDEN` | 403 | Không đủ quyền |
| `NOT_FOUND` | 404 | Không có hoặc không thuộc về bạn |
| `EMAIL_TAKEN` | 409 | Email đã đăng ký |
| `ACCOUNT_LOCKED` | 423 | Tài khoản bị khóa |
| `RATE_LIMITED` | 429 | Thao tác quá nhanh |
| `INTERNAL_ERROR` | 500 | Lỗi không lường trước (tự động) |

**Thêm mã lỗi mới:** thêm vào `ErrorCodeSchema`, `HTTP_STATUS`, `ERROR_MESSAGES` trong
`error.schema.ts` (TypeScript sẽ báo thiếu nếu bạn quên một trong ba), rồi khai báo ở `errors` của
route trong registry.

> Với tài nguyên của người khác, trả `NOT_FOUND` thay vì `FORBIDDEN` để không lộ việc nó tồn tại.

### 6.2 Trả response

```ts
import { created, noContent, ok, paginated } from '../../utils';

ok(res, data);                        // 200 { data }
created(res, data);                   // 201 { data }
noContent(res);                       // 204, không có body
paginated(res, items, meta);          // 200 { data: [...], meta }
```

Phân trang theo trang (`?page=&limit=`): `PaginationQuerySchema` (mặc định `page=1`, `limit=20`,
tối đa 100) cho schema query; `toOffset(query)` cho `LIMIT/OFFSET`;
`buildPaginationMeta(query, total)` cho `meta`.

### 6.3 Xác thực và phân quyền

| Cần | Dùng |
|---|---|
| Phải đăng nhập | `requireAuth` ở route |
| Chỉ admin | `requireAuth, requireRole('ADMIN')` |
| Lấy người dùng hiện tại | `getAuth(res)` trong controller → `{ userId, role, sessionId }` |

- Access token (JWT) sống 15 phút, gửi qua header `Authorization: Bearer <token>`.
- Refresh token nằm trong cookie `bk_refresh` (httpOnly), chỉ dùng cho `/auth/refresh` và `/auth/logout`.
- Lưu ý: `requireAuth` chỉ kiểm tra chữ ký và hạn của JWT, **không** hỏi DB. Nghĩa là sau khi
  logout hoặc khóa tài khoản, access token cũ còn dùng được đến khi hết hạn. Việc nào nhạy cảm
  (quản trị) cân nhắc kiểm tra thêm phiên trong DB.

### 6.4 Transaction

Việc nào gồm nhiều câu lệnh phải thành công cùng nhau thì bọc trong `withTransaction` và truyền
`client` (không phải `pool`) vào **mọi** lệnh gọi repository bên trong:

```ts
import { withTransaction } from '../../db';

await withTransaction(async (client) => {
    const user = await authRepository.insertUser(client, { ... });
    await authRepository.insertAuthToken(client, { userId: user.id, ... });
});
```

Sai thường gặp: quên truyền `client` (lệnh chạy trên `pool`, ngoài transaction, tự commit riêng). Với
`db` là tham số bắt buộc ở đầu, trình biên dịch sẽ nhắc bạn truyền một giá trị rõ ràng.

Gửi email, gọi dịch vụ ngoài làm **sau** khi transaction commit, và không để lỗi gửi làm hỏng
request (xem mẫu `sendMailSafely` trong `auth.service.ts`).

### 6.5 Validate dữ liệu đầu vào

```ts
const body = LoginBodySchema.parse(req.body);          // đầu controller
const query = ListBooksQuerySchema.parse(req.query);
```
- Hợp lệ: nhận về dữ liệu đã parse (ép kiểu, cắt khoảng trắng, thêm giá trị mặc định, bỏ trường lạ).
  Luôn dùng giá trị trả về, **không** dùng lại `req.body` gốc.
- Sai: `ZodError` được ném, `errorMiddleware` trả `400 VALIDATION_ERROR` với `details` từng trường.
- Lỗi nghiệp vụ gắn vào một trường (ví dụ "mật khẩu hiện tại sai"): `throw fieldError('currentPassword', '...')`.
- Cần quy tắc đặc biệt (ví dụ mật khẩu tính theo **byte**): viết trong schema (`.refine`), để FE
  cũng dùng được.

### 6.6 Giới hạn tần suất, email, cấu hình

**Rate limit:** `rateLimitMiddleware({ windowMs, limit, enabled, skipSuccessfulRequests? })`. Đặt
trước controller. Giới hạn theo từng địa chỉ email (chống spam thư) viết ở service và **âm thầm bỏ
qua**, vì giới hạn công khai theo email cho phép người khác khóa bạn.

**Gửi email:**
```ts
import { getMailer } from '../../lib';
await getMailer().send({ to, subject, text });
```
Hiện mailer chỉ **ghi log** (dev in cả nội dung, production chỉ ghi người nhận và tiêu đề). Khi cần
gửi thật, thêm một `Mailer` rồi `setMailer(...)` lúc khởi động. Test dùng `setMailer` với mailer giả
để lấy link ra.

**Cấu hình:** thêm biến vào `src/config/env.ts` (zod, có mặc định hợp lý) và `.env.example`. Dùng
qua `import { env } from '../../config'`. Không đọc `process.env` trực tiếp ở nơi khác. Chú thích
trong `.env` đặt ở dòng riêng bắt đầu bằng `#`; **không** viết `// ...` cuối dòng (giá trị sẽ hỏng).

**Log:** dùng `logger` từ `config`. Khi log lỗi dùng khóa `err` (`logger.error({ err }, '...')`) để
pino hiển thị stack trace.

### 6.7 Migration

```bash
pnpm db:new ten-migration        # tạo file mới
pnpm db:migrate                  # chạy các migration chưa chạy
pnpm db:rollback                 # lùi 1 bước (dùng phần Down Migration)
pnpm db:rollback 0               # lùi tất cả
pnpm db:seed                     # tạo tài khoản admin (idempotent)
```

Quy tắc:
- **Không sửa migration đã chạy** (nhất là đã commit hoặc đã áp dụng ở máy người khác). Tạo
  migration mới. Phần `Down` của file đã sửa có thể không còn khớp với DB đang có.
- Luôn viết đủ `-- Down Migration` hoàn tác chính xác phần Up. CI chạy up, rollback hết, up lại.
- Mỗi migration một việc nhỏ.
- Dùng khóa ngoại với `ON DELETE` có chủ ý (`RESTRICT`, `CASCADE`, `SET NULL`).
- Bảng "chỉ thêm" (`audit_logs`, `book_versions`) có trigger chặn sửa và xóa. Đừng cố
  `UPDATE`/`TRUNCATE` chúng trong code hay test.

### 6.8 Worker

`src/worker` hiện là khung (chưa có hàng đợi). Khi cần việc nền, bàn trong nhóm chọn cách
làm; chưa có quy ước.

---

## 7. Kiểm thử

```bash
pnpm docker:up       # bật Postgres (cần cho test tích hợp)
pnpm test            # chạy toàn bộ
pnpm check           # biome + typecheck + test
```

- Test tích hợp dùng **một database riêng** `<tên DB>_test` (ví dụ `bookaria_test`): tự tạo, tự
  migrate trước khi chạy và tự xóa sau. **Không** chạm vào DB dev. Đặt `TEST_DATABASE_URL` để chỉ
  định DB khác.
- Không có Postgres thì các test cần DB bị **bỏ qua** (có cảnh báo). Trên CI (biến `CI`) thì báo
  lỗi thay vì bỏ qua.
- Cấu hình test (`vitest.config.ts`): rate limit tắt, `BCRYPT_ROUNDS=4`, cookie không `Secure`.
  Muốn thử rate limit: `createApp({ rateLimit: true })`.
- Mỗi test tạo dữ liệu riêng (email ngẫu nhiên) nên không cần dọn.
- Lấy link xác minh hoặc đặt lại mật khẩu: `setMailer({ async send(mail) { sent.push(mail); } })`
  rồi đọc `sent`.
- Hàm thuần và schema: viết test đơn vị cạnh file (`pagination.test.ts`, `auth.schema.test.ts`),
  không cần DB.
- Mẫu đầy đủ nhất: `src/modules/auth/auth.test.ts`.

---

## 8. Trước khi tạo PR

Checklist:

- [ ] `pnpm check` xanh (biome, typecheck, test).
- [ ] Đổi `schema/` hoặc registry thì đã chạy `pnpm contract:sync` và commit file spec.
- [ ] Có migration thì đã thử `pnpm db:migrate`, `pnpm db:rollback`, `pnpm db:migrate`.
- [ ] Có test cho: thành công, 401, 400, và trường hợp 403 hoặc 404 liên quan.
- [ ] Không còn `console.log`, token hay mật khẩu trong log.
- [ ] SQL dùng tham số, không ghép chuỗi người dùng.
- [ ] Thông báo trả người dùng bằng tiếng Việt, mã lỗi đúng `ErrorCode`.
- [ ] Commit message tiếng Anh, đúng kiểu `type(scope): mô tả`.

Hook `pre-commit` tự chạy `biome check` trên file đã stage. Lỗi định dạng thì chạy
`pnpm format`. Có thể bỏ qua hook bằng `--no-verify` nhưng CI vẫn kiểm tra lại.

Thêm hoặc gỡ gói: `pnpm add <gói>`, `pnpm add -D <gói>`, `pnpm remove <gói>`, rồi commit
`pnpm-lock.yaml`. Đừng dùng `npm`/`yarn`.

---

## 9. Lỗi thường gặp

| Triệu chứng | Nguyên nhân và cách xử lý |
|---|---|
| App không khởi động, báo "Biến môi trường không hợp lệ" | `.env` sai. Hay gặp: có `// chú thích` cuối dòng, `JWT_SECRET` ở production là giá trị mặc định. So với `.env.example` |
| Test tích hợp bị bỏ qua | Postgres chưa chạy: `pnpm docker:up` |
| `refresh` luôn 401 khi thử qua `http://localhost` | Cookie `Secure` không được gửi qua http: đặt `COOKIE_SECURE=false` và `COOKIE_SAMESITE=lax` trong `.env` |
| Không thấy email xác minh | Mailer đang ghi log: tìm link trong terminal chạy `pnpm dev` |
| `rollback` báo "function ... does not exist" | File migration đã bị sửa sau khi chạy. Xem mục 6.7 |
| Lỗi 429 khi thử tay nhiều lần | Rate limit đang bật. Chờ hết cửa sổ hoặc đặt `RATE_LIMIT_ENABLED=false` ở máy dev |
| Sau khi cài gói, CI hỏng ở bước test | Đảm bảo đã commit `pnpm-lock.yaml`; dùng `pnpm`, không `npm` |
| `pnpm` lỗi ngoài thư mục dự án | `corepack install -g pnpm@10.34.6` (xem README) |

---

## Nên đọc theo thứ tự

1. `src/app.ts`, `src/modules/index.ts`: cách mọi thứ được lắp.
2. `src/modules/auth/`: module mẫu hoàn chỉnh (routes, controller, service, repository, constants,
   test). Đọc `auth.service.ts` để thấy transaction, lỗi, email, phát hiện dùng lại refresh token.
3. `src/schema/routes.schema.ts` và `src/schema/error.schema.ts`: hợp đồng và mã lỗi.
4. `src/middlewares/`: các bước xử lý trước controller.
5. `src/modules/auth/auth.test.ts`: cách viết test tích hợp.
