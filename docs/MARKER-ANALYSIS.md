# Phân tích marker theo Pictarize

Từ 06/11/2026, luồng SCORE_MARKER mới không quy đổi về 5 sao. Báo cáo có `analysis.policyVersion = mindar-pictarize-v1` và ba số độc lập trong [0,1]:

- `distribution`: tỷ lệ ô có ít nhất một điểm trong lưới 10×10.
- `uniqueness`: tỷ lệ điểm không có descriptor cùng nhóm maxima/minima với khoảng cách Hamming dưới 50. Descriptor MindAR FREAK gồm 21 số nguyên 32 bit.
- `dimension`: điểm cạnh ngắn và tỷ lệ hai cạnh, theo các ngưỡng trong bundle Pictarize đã kiểm tra. Giữ cả nhánh aspect <0,8 bị gán 3, không tự sửa thành một công thức khác.

Không có điểm tổng. Mỗi tiêu chí trên UI dùng phần trăm và 10 vị trí sao như Pictarize; sao làm tròn lên, phần trăm là số đo được làm tròn để hiển thị. Ảnh không có feature trả distribution=0, uniqueness=0, không sinh NaN.

## Hai luồng

1. **Thử ảnh trong Studio:** `analyzeMarkerImage` mở iframe riêng, nạp MindAR 1.2.5 đã có trong dự án, đưa cạnh dài về 800 px giống Pictarize, biên dịch tại trình duyệt và lấy matchingData mức đầu. Kích thước ảnh gốc dùng riêng cho dimension. Ảnh không được upload lên API hay dịch vụ phân tích. Hủy/đóng xóa iframe, listener và blob URL.
2. **Worker cho trang Custom:** tải `.mind` đã biên dịch trước từ trình duyệt; giải mã MessagePack, lấy matchingData mức đầu rồi chạy cùng hàm `analyzeMindarLevel`. Không chạy compiler trên server. Kích thước nguồn là ảnh trang được pad theo `pageImageTransform`, khớp ảnh dùng để nhận diện/in. ORB hiện có chỉ được dùng nội bộ cho so khớp các trang và tạo PNG nền; điểm ORB không được lưu thành kết quả mới.

Luồng biên dịch marker dùng trong AR hiện có giới hạn 1024 px và được giữ nguyên. Vì vậy phép đo từ `.mind` 1024 px có thể khác phép thử ảnh 800 px; worker đo dữ liệu nhận diện thực tế thay vì tự biên dịch lại ở 800 px. Thư viện MindAR của Pictarize cũng có thể khác bản 1.2.5 của dự án: áp dụng cùng cách tính không bảo đảm từng điểm phát hiện giống hệt website.

## Tương thích và xuất bản

- Trường `marker_report.analysis` mới là tùy chọn. Báo cáo cũ vẫn đọc được.
- Kết quả worker mới đặt `pages.marker_score = NULL`; `marker_features`/`marker_report` chứa số điểm và ba tiêu chí MindAR. Job SCORE_MARKER trả `score: null` để tương thích hình dạng kết quả cũ, không quy đổi thành sao.
- Từ 07/11/2026, xuất bản yêu cầu báo cáo MindAR gắn đúng ảnh, tệp marker và khổ trang hiện tại (`marker_report.source`). Worker lưu ID ảnh/tệp, tỷ lệ trang và SHA-256 của ảnh chuẩn hóa/tệp đã đọc; kết quả cũ hoặc thiếu thông tin nguồn yêu cầu **Đánh giá lại**. Không dùng ngưỡng tổng 3/5 sao nữa, kể cả với báo cáo cũ.
- Chặn khi tệp marker thiếu, dữ liệu lỗi, đang phân tích/phân tích thất bại, không có đặc trưng, nguồn đã thay đổi hoặc marker trùng giữa hai trang. Worker xuất bản kiểm tra lại chính tệp tải xuống và phát hiện tệp thay đổi/trùng. Đổi ảnh hoặc tỷ lệ trang phải cung cấp một tệp biên dịch mới; retry nguyên lô đã áp dụng vẫn an toàn.
- Phân bố/độ khác biệt dưới 50%, cạnh ảnh nhận diện dưới 1000 px và các cặp ảnh gần giống chỉ tạo cảnh báo có thể chấp nhận. Không đặt ngưỡng chặn riêng cho ba chỉ số. Marker Bookaria cần được kiểm định/đang hoạt động và giữ giới hạn in 35 mm, cách mép 12 mm. Trang NONE không chịu kiểm tra marker; các điều kiện xuất bản sách khác giữ nguyên.
- Chính sách chỉ áp dụng cho bản xuất bản mới; lưu nháp, xem trước 3D và phiên bản đã phát hành không bị thay đổi. Dùng **Đánh giá lại** trong AR Marker để cập nhật báo cáo từng trang; không tự sửa hàng loạt dữ liệu đã lưu.
- API thử ảnh ORB cũ và CLI `score-markers-local.ts` được giữ để tương thích/chẩn đoán cũ; hộp thử ảnh mới không sử dụng API đó.
- Schema được sync sang cả Studio và Viewer; không cần migration vì báo cáo đã lưu trong JSONB và marker_score đã nullable.

## Đo lại từ ảnh và `.mind` đã có

```
pnpm exec tsx src/scripts/analyze-markers-local.ts <thư-mục-ảnh> <thư-mục-mind> <thư-mục-kết-quả-mới>
```

Ảnh `ten.png` cần file `ten.mind`. Script giải mã target, không biên dịch. Có thể dùng để đối chiếu cùng dữ liệu mà worker đọc.

Kiểm chứng ngày 06/11/2026: 640 test backend qua; 465 test Studio qua sau khi cho phép HTTP local ngoài sandbox; typecheck/build backend và Studio qua; typecheck Viewer và kiểm tra contract hai frontend qua. Bộ 12 trang Rùa và Thỏ đã chạy bằng compiler trình duyệt ở 800 px, tạo `.mind` 1024 px và đọc lại bằng hàm worker. Hủy phân tích không để lại iframe; giao diện thật có ba tiêu chí, lưới 100 ô và không có tổng 5 sao. Chưa kiểm định camera/bản in thật.
