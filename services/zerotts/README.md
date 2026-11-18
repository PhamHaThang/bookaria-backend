# ZeroTTS — thử nghiệm lời thuyết minh tiếng Việt

Dịch vụ chạy CPU, chỉ lắng nghe `127.0.0.1:8010`. Express kiểm tra đăng nhập
và giới hạn tần suất trước khi chuyển yêu cầu. Model được giữ
trong RAM; weights tải lần đầu khoảng 900 MB, cache không đưa vào Git.

Từ thư mục backend, cài Python 3.11+ rồi chạy:

```powershell
uv venv services/zerotts/.venv --python 3.11
uv pip install --python services/zerotts/.venv/Scripts/python.exe -r services/zerotts/requirements.txt
```

Thêm vào `.env` của backend:

```dotenv
ZEROTTS_URL=http://127.0.0.1:8010
ZEROTTS_API_KEY=replace-with-a-random-secret
ZEROTTS_TIMEOUT_MS=180000
```

Chạy hai terminal riêng:

```powershell
pnpm dev:tts
pnpm dev
```

Kiểm tra sẵn sàng: `http://127.0.0.1:8010/health`. Studio → Tài nguyên của tôi →
Tạo âm thanh → chọn giọng, nhập nội dung → Tạo lời đọc. Trong editor, nút này
cũng có ở Thư viện âm thanh → Tài nguyên của tôi, cạnh Tải lên.
Modal giữ bản nghe thử để nghe lại, tạo lại và đặt tên. Khi hài lòng, bấm
**Lưu vào tài nguyên**; lúc này mới upload MP3 bằng luồng tài nguyên hiện có.
Tệp MP3 dùng 96 kbps CBR, mono, 48 kHz. ZeroTTS tạo PCM nội bộ rồi mã hóa MP3 một lần;
nghe thử và lưu dùng cùng một tệp. WAV/MP3 đã tải lên trước đó vẫn dùng như cũ.
Tệp đã lưu xuất hiện trong Âm thanh của tài nguyên cá nhân và được xử lý như tệp tải từ máy.
Không cần có sách hay trang để tạo. Đóng modal khi đang tạo sẽ hủy yêu cầu;
không thể đóng trong lúc đang lưu. Lưu lỗi vẫn giữ bản nghe thử để thử lại.

Mỗi giọng có một MP3 mẫu tại `bookaria-studio/public/audio/voice-samples/`.
Bấm avatar để nghe mẫu, bấm tên để chọn giọng; các tệp mẫu đã được tạo sẵn,
không gọi AI khi phát.
Cả 8 mẫu đọc cùng nội dung để dễ so sánh:

> Xin chào! Chào mừng bạn đến với Bookaria – nền tảng sáng tạo và trải nghiệm sách tương tác, kết hợp công nghệ thực tế tăng cường và trí tuệ nhân tạo.

Tạo lại các mẫu từ model đã ghim phiên bản (chạy từ thư mục backend):

```powershell
services/zerotts/.venv/Scripts/python.exe -X utf8 services/zerotts/generate_samples.py ../bookaria-studio/public/audio/voice-samples
```

API có xác thực Bookaria:

- `GET /api/v1/assets/narration/voices`
- `POST /api/v1/assets/narration/generate` với `{ "text": "Xin chào.", "voice": "maichi" }`, trả MP3, chưa tạo asset.

Các tùy chọn (bỏ qua sẽ dùng mặc định):

| Trường | Giá trị | Mặc định |
| --- | --- | --- |
| `speed` | 0.8–1.2 | 1 |
| `pause` | `short`, `medium`, `long` (50, 150, 400 ms) | `medium` |
| `temperature` | 0.5–1.0, chuyển vào `audio_temperature` | 0.8 |
| `voiceStrength` | 1–1.5, chuyển vào `cfg_scale` | 1 |

Khoảng nghỉ chỉ chèn giữa các đoạn xuống dòng và các phần nội dung dài do ZeroTTS chia,
không chèn sau mỗi câu hoặc cuối tệp. Tốc độ dùng FFmpeg `atempo` giữ cao độ trước khi
mã hóa MP3; gói `imageio-ffmpeg` cung cấp executable trên Windows/Linux/macOS thông dụng.
Khoảng nghỉ cũng thay đổi theo tốc độ đọc. Tăng độ bám giọng có thể làm thời gian tạo lâu hơn.
Studio đặt các tùy chọn biến thiên và bám giọng trong mục nâng cao; đổi tùy chọn phải tạo lại
trước khi lưu. Đóng modal đặt lại toàn bộ form.

Giới hạn bản thử: 1.500 ký tự/lượt, âm thanh tối đa khoảng 3 phút, một lượt tạo
trên mỗi dịch vụ. Hủy trên Studio không ngắt ONNX đang tính; dịch vụ hoàn tất
hoặc dừng theo hạn thời gian rồi nhận lượt tiếp. Chưa có hàng đợi hay clone giọng.
Để chạy nhiều API replica, chuyển sang job worker có hàng đợi trước.
Trên Linux, đường dẫn Python cài đặt là `services/zerotts/.venv/bin/python`.

Theo tài liệu hiện tại, mã và weights ZeroTTS dùng MIT, codec MOSS dùng Apache-2.0.
Bản thử dùng 8 giọng có sẵn; không có chức năng clone giọng từ tệp thu âm.
Xem [giấy phép](https://github.com/zeroweight-ai/ZeroTTS#license) và
[giọng có sẵn](https://github.com/zeroweight-ai/ZeroTTS/blob/main/docs/VOICES.md).

Kiểm thử cục bộ (database kiểm thử được tạo riêng, không sửa sách đang dùng):

```powershell
services/zerotts/.venv/Scripts/python.exe -X utf8 -m unittest discover -s services/zerotts -p test_server.py
pnpm exec vitest run src/modules/narration/__tests__/routes.test.ts
# Có service đang chạy: thêm một lượt kiểm thử API với model thật.
$env:ZEROTTS_SMOKE='1'
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run src/modules/narration/__tests__/routes.test.ts
Remove-Item Env:ZEROTTS_SMOKE
```
