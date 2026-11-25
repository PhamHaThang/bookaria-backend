# bookaria-backend

API và worker của Bookaria (Node.js, Express, PostgreSQL).

Trợ lý tạo tương tác bằng tiếng Việt: [cấu hình OpenAI và sử dụng](docs/AI-INTERACTIONS.md), [bộ tác vụ và thực nghiệm A/B/C](research/interaction-ai/README.md).

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

Cấu hình bucket, CORS, xử lý media và giới hạn PDF: [R2 storage](docs/R2-STORAGE.md).

## Tạo lời đọc tiếng Việt

Cài môi trường Python theo [hướng dẫn ZeroTTS](https://github.com/PhamHaThang/bookaria-zerotts).
Khi chạy Bookaria từ repo gốc, submodule `bookaria-zerotts` nằm cạnh backend.
Chạy `pnpm dev:tts` từ backend để khởi động dịch vụ cục bộ. Đặt `ZEROTTS_URL`
và `ZEROTTS_API_KEY` trong `.env` của backend theo cấu hình dịch vụ.

## Tạo mô hình 3D từ ảnh

Studio → **Tài nguyên của tôi → Tạo 3D từ ảnh** dùng worker Hunyuan3D từ submodule `bookaria-3d-generative`, qua [RunPod Serverless](https://docs.runpod.io/serverless/endpoints/operation-reference). Worker cần hỗ trợ `action: pipeline` và trả các sự kiện `result` (kiểm tra nội dung), `file_meta`, `file_chunk`, `done`. Không dùng endpoint OpenAI cho tính năng này.

- Đặt `RUNPOD_MODEL_ENDPOINT_ID` và `RUNPOD_MODEL_API_KEY` trong `.env` của backend; không đưa token vào Studio. Chạy migration và khởi động lại API/worker.
- Chạy `pnpm dev:worker`, hoặc đặt `RUN_WORKER_IN_PROCESS=true`. Một ảnh JPG/PNG tối đa 6 MiB, 16 megapixel; cần ít nhất 50 MiB dung lượng trống. Mỗi tác giả tạo một mô hình tại một thời điểm, tối đa 6 lượt/giờ.
- `POST /assets/upload-signature` với `purpose: MODEL_INPUT`, PUT ảnh lên R2, rồi `POST /assets/model-generations` với `{ "inputId": "assetId từ chữ ký" }`. Gửi lại cùng `inputId` trả cùng tác vụ. `GET /assets/model-generations` hoặc `GET /jobs/:jobId` theo dõi tác vụ thuộc tác giả.
- Tác vụ chạy nền cả khi đóng Studio. Pipeline kiểm tra nội dung, tạo hình và texture 1024px với mục tiêu 40.000 mặt. Backend kiểm tra chunk, SHA-256 và GLB rồi đưa vào `OPTIMIZE_ASSET` để tối ưu, tạo thumbnail và dùng trong sách.
- Thumbnail dùng GLB tối ưu sẵn trong RAM, không tải lại từ R2. Texture hợp lệ không vượt 1024px được giữ nguyên; chỉ resize khi quá lớn hoặc thử nén khi GLB vượt giới hạn tải 10 MiB, và chỉ giữ bản nén nhỏ hơn. Bản gốc vẫn được lưu để có thể tối ưu lại mà không gọi GPU.
- Worker Hunyuan chịu trách nhiệm xuất vật liệu PBR rõ ràng. Backend giữ nguyên metalness/roughness trong GLB, chỉ kiểm tra, tối ưu dung lượng và tạo thumbnail.
- Mỗi yêu cầu RunPod có giới hạn chạy 20 phút và TTL 30 phút. Backend không tự gửi lại yêu cầu GPU khi mất phản hồi. Nếu worker Bookaria khởi động lại giữa lúc nhận stream, tác vụ báo gián đoạn; kiểm tra RunPod trước khi tạo lại. Có thể tiếp tục lưu kết quả nếu GLB đã được ghi lên R2 trước khi worker dừng.
- Ảnh đầu vào nằm trong prefix riêng `bookaria/model-inputs/`, được dọn sau khi hết hạn và không còn tác vụ chạy. Mô hình thất bại không có asset cũng được dọn. Tính năng tạo GLB có texture, chưa tạo rig hoặc animation.

Kiểm thử phần tích hợp: `pnpm exec vitest run src/modules/model-generation/__tests__`. Kiểm thử trình duyệt ở Studio: `pnpm exec playwright test --config=playwright.interactions.config.mjs assets-generate-3d.spec.mjs`.

## Khởi tạo dữ liệu

Chạy trong thư mục backend sau khi cấu hình `.env` và bật Postgres:

Đặt `SEED_ADMIN_PASSWORD` trong `.env` local trước khi tạo tài khoản quản trị đầu tiên.
Khi triển khai production, khai báo biến này trong kho bí mật của nền tảng triển khai
và truyền vào bước chạy `pnpm db:seed`. API và worker có thể khởi động khi biến này để trống.
Nếu tài khoản đã tồn tại, hãy dùng chức năng đặt lại mật khẩu của Bookaria để đổi mật khẩu.

```bash
pnpm db:migrate
pnpm db:seed                # Tạo admin nếu chưa có
pnpm db:seed:markers --dry-run  # Kiểm tra bộ marker, không upload/ghi DB
pnpm db:seed:markers        # Tải tệp còn thiếu và đăng ký marker
```

Bộ 20 marker đi kèm nằm ở `assets/bookaria-markers/`: `png/` chứa ảnh gốc,
`mind/` chứa nhận diện đã biên dịch và `manifest.json` lưu checksum/điểm từng mẫu.
Seed giữ nguyên cặp ảnh/nhận diện, không biên dịch lại trên backend.

Seed marker dùng `DATABASE_URL` và các biến `R2_*` trong `.env`. Tệp đã có trên
R2 với cùng object key sẽ không được upload lại; marker đã có trong DB
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
