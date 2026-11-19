# R2 storage

Bookaria dùng R2 qua S3 API cho tệp gốc, tệp đã xử lý, thumbnail, marker,
preview, manifest, QR và PDF.
Các cột `*_public_id` hiện lưu object key R2, không phải URL.

## Cấu hình bucket

1. Cloudflare Dashboard → R2 → tạo bucket `bookaria-dev`, chọn **Standard**.
2. Tạo R2 API token có quyền **Object Read & Write**, chỉ áp dụng cho bucket này.
   Lưu Access Key ID, Secret Access Key và S3 endpoint.
3. Settings → Public Development URL: bật `r2.dev` để thử ở môi trường dev.
   Production dùng custom domain, ví dụ `assets.bookaria.com`.
4. Điền các biến sau vào `.env` của backend, không đặt credentials trong Studio/Viewer:

```dotenv
R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY
R2_BUCKET=bookaria-dev
R2_PUBLIC_URL=https://pub-YOUR_ID.r2.dev
```

`R2_PUBLIC_URL` phải tải được object bằng HTTPS. Endpoint S3 dùng để ký upload,
không dùng làm public URL. Không đặt bucket name vào cuối public URL.
Bucket phục vụ URL công khai, tương tự luồng media trước đây; đây không phải kho tệp riêng tư.

## CORS

Trong bucket Settings → CORS Policy, dùng cấu hình dưới đây và thay/bổ sung
đúng origin Studio và Viewer thực tế (kể cả địa chỉ LAN khi thử điện thoại).
Địa chỉ LAN dưới đây là ví dụ; đổi theo `VIEWER_URL` của máy đang chạy dev.
Thiếu origin Viewer sẽ làm manifest/âm thanh/model trên R2 bị trình duyệt chặn:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "https://localhost:5174",
      "https://viewer.localhost:5174",
      "https://192.168.1.79:5174"
    ],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": [
      "Content-Type", "If-None-Match", "x-amz-meta-format", "Cache-Control", "Range"
    ],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

Backend kiểm tra đăng nhập, quota và loại tệp trước khi cấp URL PUT hết hạn sau
15 phút. Chữ ký ràng buộc dung lượng, MIME, metadata định dạng và điều kiện
`If-None-Match: *` để không ghi đè. Studio gửi trực tiếp byte tệp lên endpoint
S3, không gửi token/cookie đăng nhập Bookaria; gặp 412 khi thử lại sẽ tiếp tục
bước xác minh tệp. Backend đọc lại dung lượng và kiểm tra nội dung trước khi ghi nhận.

## Xử lý media

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Linux cần `pnpm exec playwright install --with-deps chromium`.
Worker dùng Chromium/Three.js để tạo thumbnail model 3D; FFmpeg/ffprobe được cài
cùng dependency để tạo thumbnail video và đọc thời lượng/kích thước media.
`FFMPEG_PATH` và `FFPROBE_PATH` là tùy chọn ghi đè đường dẫn binary.

Ảnh gốc được giữ trên R2. Ảnh tài nguyên, model, audio và video tiếp tục dùng
URL gốc hoặc bản tối ưu đã có. Chỉ thumbnail/avatar và ảnh trang theo khổ sách
cần bản xử lý riêng bằng Sharp. API chuẩn bị bản còn thiếu trước khi trả URL
R2 HTTPS trực tiếp; trình duyệt không tải byte ảnh qua backend.

Danh sách trang chỉ chuẩn bị thumbnail nhỏ. Mở trang/đổi khổ hoặc tạo preview,
xuất bản và bố cục in sẽ chuẩn bị ảnh đúng tỉ lệ trước khi trả kết quả, kể cả
trang không dùng AR. Các trang dùng cùng nguồn và cùng kích thước tái sử dụng
cùng object `derived/v1/…`; đổi khổ tạo biến thể khác, giữ bản cũ cho phiên bản
đã xuất bản. Worker chấm marker và in PDF dùng cùng phép biến đổi ảnh.

Mỗi storage instance giữ tối đa 256 tác vụ chuẩn bị ảnh để gộp yêu cầu trùng,
bỏ qua HEAD lặp lại và không giữ các tác vụ lỗi. Sau khi khởi động lại, HEAD
kiểm tra bản có sẵn trước khi tạo; không ghi đè ảnh đã có. Ảnh được cache một năm
bằng URL bất biến.

Không cần đổi `PUBLIC_API_URL` giữa máy tính và điện thoại để tải ảnh mới.
Origin Studio/Viewer thực tế vẫn phải có trong CORS bucket. Viewer dev gọi API
qua `/api/v1` trên cùng origin và proxy tới backend; khi tải marker preview,
Viewer dựng lại đường dẫn theo API base này, không dùng hostname local trong
manifest. `PUBLIC_API_URL` vẫn cung cấp URL API tuyệt đối trong dữ liệu preview
cho các client khác; các client dùng URL đó cần địa chỉ truy cập được.

`VIEWER_URL` và `VITE_VIEWER_ORIGIN` của Studio phải trỏ tới địa chỉ Viewer mà
điện thoại mở được để link/QR đúng. Giữ Viewer chạy khi demo qua proxy; `localhost`
chỉ trỏ về thiết bị đang mở trình duyệt. Khởi động lại API/worker sau khi đổi `.env`.

Kiểm tra metadata R2 bằng HEAD gửi `Accept-Encoding: identity` để
`Content-Length` phản ánh byte gốc, tránh báo sai dung lượng khi HTTP nén JSON/SVG.

Studio chờ tối đa 120 giây cho bước hoàn tất upload để backend đọc metadata
và tạo thumbnail. Quota được khóa trong transaction trước khi ghi nhận tài nguyên,
ngăn hai upload đồng thời vượt hạn mức. Tệp ảnh/audio/video không hợp lệ trả 422
và được xóa khỏi R2; lỗi kết nối, hủy, timeout hoặc thiếu công cụ xử lý giữ tệp
để có thể thử lại.

PDF đầu ra cho phép tối đa **100 MB**. Giới hạn nhóm `.mind` vẫn giữ **9 MB**
và tối đa 10 trang/nhóm để kiểm soát tải AR trên điện thoại.

| Loại | Đầu vào tối đa | Bản dùng khi đọc |
| --- | --- | --- |
| Model GLB/GLTF nhúng đầy đủ dữ liệu | 50 MiB | GLB sau tối ưu tối đa 10 MiB |
| Ảnh tài nguyên, ảnh trang, ảnh bìa | 10 MiB | Giữ giới hạn hiện tại; ảnh trang in/nhận diện được tạo theo tỉ lệ |
| Audio MP3/WAV | 100 MiB | Phát trực tiếp qua URL, không tải toàn bộ vào cache model |
| Video MP4 | 100 MiB | Phát trực tiếp qua URL |
| Avatar | 2 MiB | Biến thể 256 px |
| Marker .mind | 5 MiB | Nhóm tối đa 9 MB và 10 target |
| PDF | Nhập trong Studio: 50 MiB | Xuất tối đa 100 MB |

Model nên ở khoảng 2–5 MiB sau nén; 10 MiB là trần, không đảm bảo tốc độ khung hình.
Worker vẫn nhắm 50.000 tam giác, texture tối đa 1024 px/cạnh và 16.777.216 pixel
đầu vào/texture; giữ chặn bộ đệm giải nén 128 MiB và tổng số phần tử accessor
4 triệu. Morph target không bị giảm lưới. Thumbnail được tạo từ GLB đã tối ưu,
tránh giải mã lại tệp nguồn lớn trong Chromium. Studio và Viewer dùng chung
`MODEL_MAX_DOWNLOAD_BYTES` để chặn quá 10 MiB khi tải, kể cả khi metadata sai.
Giới hạn cache hiện tại được giữ để không tăng bộ nhớ trên điện thoại.
Quota tài khoản mặc định vẫn là 500 MiB; thay đổi này không tự tăng quota.

Sau khi điền `.env`, khởi động lại API/worker, tải lại tài nguyên và seed lại marker:

```powershell
pnpm db:seed:markers
pnpm dev
# Terminal khác:
pnpm dev:worker
```

## Biến thể ảnh và dọn tệp

Ảnh biến thể dùng key `derived/v1/<sha256-key-gốc>/<biến-thể>.jpg`.
Tăng phiên bản khi thay đổi thuật toán nén/resize để cache cũ không che kết quả mới.
Khi hoàn tất upload ảnh, backend chuẩn bị thumbnail (320 px) hoặc avatar (256 px)
trước khi trả `READY`. URL được lưu trong database và trỏ trực tiếp R2;
ảnh bìa trong danh sách sách dùng thumbnail này. Không cần thêm request qua API.
Ảnh trang theo tỉ lệ được chuẩn bị khi cần trước khi API trả URL R2 trực tiếp;
các lần sau tái sử dụng object và bộ nhớ đệm chuẩn bị có giới hạn.

Worker (chạy riêng hoặc trong API) kiểm tra lúc khởi động và mỗi giờ, tối đa
100 bản ghi/lượt. Chỉ dọn asset đã xóa ít nhất 24 giờ và chưa dọn thành công;
khóa bản ghi, kiểm tra lại mọi tham chiếu, rồi xóa tệp gốc, model tối ưu,
thumbnail và toàn bộ biến thể v1 của từng nguồn. Tác vụ có retry khi lỗi,
không chạy chồng trong cùng tiến trình; khóa database ngăn hai worker cùng xóa.

Giữ nguyên asset còn được trang, sách trong thùng rác, bìa, marker, avatar,
asset khác, bản xuất bản/print source, job chưa xong hoặc preview còn hiệu lực
sử dụng. Preview có thêm 1 giờ đệm sau hết hạn. Chỉ xóa các key do Bookaria
sinh ra; không xóa URL thư viện bên ngoài. Cột `storage_purged_at` ghi nhận
thành công, không xóa metadata/audit của asset.

Chạy migration trước khi khởi động API/worker: `pnpm db:migrate`.
Không đặt lifecycle tự xóa toàn bộ `derived/`: biến thể của sách đang dùng
phải được giữ. Tác vụ này chưa quét các upload bỏ dở hoặc tệp job thất bại
không gắn với asset đã xóa; các tệp đó cần một đợt thu gom riêng.

## Kiểm tra trước khi dùng

- Upload ảnh, audio/video, model; kiểm tra preview, thumbnail và metadata.
- Thử tạo âm thanh rồi lưu, đổi ảnh bìa/avatar, nhập marker quản trị và marker trang.
- Tạo preview, xuất bản, xuất PDF trên 9 MB; mở lại sách trong Viewer và thử tua media.
- Thử upload bị ngắt và bấm lại; không được ghi đè object hay tính dung lượng hai lần.

Chưa có credentials thì các kiểm thử chạy bằng kho R2 giả. Việc ký request,
giới hạn byte, xử lý ảnh/media và render 3D có kiểm thử riêng; vẫn cần chạy
các bước trên với bucket thật để xác nhận token, CORS và custom domain.

Tài liệu: [S3 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
[CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).
