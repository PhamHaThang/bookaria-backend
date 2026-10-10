# bookaria-backend

API và worker của Bookaria (Node.js, Express, PostgreSQL).

## Yêu cầu
- Node.js theo `.nvmrc` (>= 22)
- pnpm đúng phiên bản trong `packageManager` của `package.json` (xem mục Cài pnpm)
- Docker (cho Postgres, Mailpit)
- VS Code + extension **Biome** (được gợi ý trong `.vscode/extensions.json`)

## Cài pnpm
Chọn một cách, rồi kiểm tra bằng `pnpm --version` (phải ra đúng phiên bản trong `package.json`):

```bash
# Cách 1: corepack (Windows: mở terminal bằng quyền Administrator)
corepack enable

# Cách 2: không cần quyền admin
npm install -g pnpm@10.34.6
```
Nếu `corepack enable` báo `EPERM` thì dùng cách 2. Nếu `pnpm` báo lỗi khi chạy ngoài dự án, chạy `corepack install -g pnpm@10.34.6`.

## Chạy dự án
```bash
pnpm install --frozen-lockfile
cp .env.example .env        # rồi chỉnh giá trị nếu cần
pnpm docker:up           # Postgres, Mailpit (docker/docker-compose.yml)
pnpm dev                 # API:    http://localhost:4000/api/v1/health
pnpm dev:worker          # Worker (hoặc đặt RUN_WORKER_IN_PROCESS=true để chạy chung API)
```

## Kiểm tra trước khi push
```bash
pnpm check               # biome + typecheck + test
```
CI chạy lint, typecheck, test và build (`.github/workflows/ci.yml`).

## Tài liệu API
Hợp đồng API nằm ở `src/schema/routes.schema.ts` (nguồn sự thật). Từ đó sinh ra file OpenAPI 3.1:

```
postman/specs/bookaria-api.openapi.json
```
- **Cập nhật** sau khi sửa `routes.schema.ts`: `pnpm docs:openapi` (không sửa file JSON bằng tay).
- **Dùng thử bằng Postman:** `Import` > chọn file trên > nhập thành *Postman Collection*. Request đã trỏ sẵn
  `http://localhost:4000/api/v1` (đổi biến `baseUrl` của collection nếu API chạy cổng khác).
- Dùng được cả với Insomnia, Swagger UI, hoặc sinh client bằng các công cụ OpenAPI.
- **Kiểm tra cú pháp spec:** `npx postman-cli spec lint postman/specs/bookaria-api.openapi.json --issueType syntax`.

Lưu ý khi thử qua `http://localhost`:
- Đặt `COOKIE_SECURE=false` và `COOKIE_SAMESITE=lax` trong `.env`, nếu không cookie refresh token (`Secure`) sẽ
  không được gửi lại cho `/auth/refresh` và `/auth/logout`.
- Link xác minh email và đặt lại mật khẩu hiện in ra log của server (mailer ghi log): sao chép phần sau `token=`
  vào body của `/auth/verify-email` hoặc `/auth/reset-password`.
- Sau khi `register` hoặc `login`, copy `accessToken` vào **Authorization > Bearer Token** cho các route cần
  đăng nhập (ví dụ `/auth/resend-verification`).

## Quy ước
- Định dạng và lint do **Biome** quản lý (`biome.json`), không dùng Prettier/ESLint.
- Xuống dòng LF, thụt lề 4 space (`.editorconfig`, `.gitattributes`).
- Import tương đối, không đuôi `.js`, không `/index`.
- Schema zod của API nằm ở `src/schema/*.schema.ts`, chỉ import `zod`; tên có hậu tố `Schema`.

## Cấu trúc
```
src/
├─ main.ts, app.ts     entry API, createApp()
├─ config/             env, logger
├─ schema/             hợp đồng API (zod), dùng chung với FE
├─ db/                 pool, query, transaction
├─ middlewares/        requestId, notFound, error ...
├─ utils/              AppError, asyncHandler, pagination, response
├─ modules/            nghiệp vụ theo feature (routes, controller, service, repository)
└─ worker/             entry worker + jobs
```
