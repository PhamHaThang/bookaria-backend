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
