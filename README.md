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

## Khởi tạo dữ liệu

Chạy trong thư mục backend sau khi cấu hình `.env` và bật Postgres:

```bash
pnpm db:migrate
pnpm db:seed                # Tạo admin nếu chưa có
pnpm db:seed:markers --dry-run  # Kiểm tra bộ marker, không upload/ghi DB
pnpm db:seed:markers        # Tải tệp còn thiếu và đăng ký marker
```

Bộ 20 marker đi kèm nằm ở `assets/bookaria-markers/`: `png/` chứa ảnh gốc,
`mind/` chứa nhận diện đã biên dịch và `manifest.json` lưu checksum/điểm từng mẫu.
Seed giữ nguyên cặp ảnh/nhận diện, không biên dịch lại trên backend.

Seed marker dùng `DATABASE_URL` và `CLOUDINARY_URL` trong `.env`. Tệp đã có trên
Cloudinary với cùng Public ID sẽ không được upload lại; marker đã có trong DB
được giữ nguyên, kể cả trạng thái bật/tắt. Marker mới mặc định **bật** và có thể được cấp cho trang mới.
Có thể bật/tắt từng marker trong **Quản trị → Bộ marker Bookaria**.

Để dùng bộ khác, truyền thư mục chứa `manifest.json` vào `pnpm db:seed:markers "<thư mục>"`
hoặc đặt `BOOKARIA_MARKER_DIR` trong `.env`. Tham số thư mục được ưu tiên hơn biến môi trường.

## Kiểm tra trước khi push
```bash
pnpm check               # biome + typecheck + test
```
CI chạy lint, typecheck, test và build (`.github/workflows/ci.yml`).

Test tự tạo database riêng cho từng lượt chạy, có hậu tố PID và mã ngẫu nhiên, rồi dọn đúng
database đó khi kết thúc. Hai terminal chạy test đồng thời không dùng chung database.
`TEST_DATABASE_URL` (nếu có) hoặc `DATABASE_URL` cung cấp thông tin kết nối và tiền tố tên;
test luôn tạo tên mới, không xóa database được chỉ định trong URL. Tài khoản PostgreSQL cần
quyền tạo database. Việc này không thay đổi database mà API/worker đang dùng.

## Tài liệu API
Hợp đồng API nằm ở `src/schema/routes.schema.ts` (nguồn sự thật). Từ đó sinh ra file OpenAPI 3.1:

```
postman/specs/bookaria-api.openapi.json
```
- **Cập nhật** sau khi sửa `routes.schema.ts`: `pnpm contract:sync` (không sửa file JSON bằng tay).
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

> Đọc [GUIDE.md](GUIDE.md) để hiểu cách viết code:
- luồng một request, cấu trúc các lớp và cách thêm một endpoint từng bước.

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
