# bookaria-backend

API và worker của Bookaria (Node.js, Express, PostgreSQL, BullMQ).

## Yêu cầu
- Node.js theo `.nvmrc` (>= 22), npm
- Docker (cho Postgres, Redis, Mailpit)
- VS Code + extension **Biome** (được gợi ý trong `.vscode/extensions.json`)

## Chạy dự án
```bash
npm ci
cp .env.example .env        # rồi chỉnh giá trị nếu cần
npm run docker:up           # Postgres, Redis, Mailpit (docker/docker-compose.yml)
npm run dev                 # API:    http://localhost:4000/api/v1/health
npm run dev:worker          # Worker (hoặc đặt RUN_WORKER_IN_PROCESS=true để chạy chung API)
```

## Kiểm tra trước khi push
```bash
npm run check               # biome + typecheck + test
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
