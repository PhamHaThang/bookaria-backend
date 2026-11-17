# Thực nghiệm sinh tương tác tiếng Việt

## Trạng thái bằng chứng

Đã chuẩn bị 120 tác vụ tổng hợp có oracle hành vi: **30 dev/90 test**, thuộc **40 nhóm kịch bản, mỗi nhóm 3 cách diễn đạt**. Cùng nhóm luôn thuộc một split. Đây là **bản nháp do trợ lý hỗ trợ biên soạn, chưa được tác giả/giảng viên rà soát**, không phải corpus thu thập từ người dùng thật.

Các nhóm dev và test có tổ hợp hành vi khác nhau; tên/loại đối tượng và hành động nguyên thủy có thể trùng. Vì phần lớn dùng cùng một bối cảnh Rùa/Thẻ, kết quả chỉ đo biến thể ngôn ngữ và tổ hợp hành vi trong miền hẹp. Không dùng nó để tuyên bố khái quát hóa sang nhiều sách, văn phong hoặc mọi tác giả. Trước khi khóa test chính thức, bổ sung/rà soát các ngữ cảnh sách khác và giữ toàn bộ biến thể cùng ngữ cảnh ở một split. Mọi thay đổi phải tạo checksum mới.

Lượt đo 90 ca với prompt v2 qua endpoint tự host cho A/B/C lần lượt 33/60, 49/60 và 58/60 đề xuất đúng hành vi. Cả 25 lỗi lượt đầu đều có trường `$schema` thừa. Bỏ riêng trường đó và chấm lại đầu ra gốc cho kết quả 58/60 với một lượt gọi. Các ca test cũ đã được phân tích và chỉ nên dùng để so trước/sau trên cùng dữ liệu. Chưa có nghiên cứu người dùng. Nghiên cứu trước gồm [LLMR](https://arxiv.org/abs/2309.12276), [LLMER](https://arxiv.org/abs/2502.02441) và [agentAR](https://engineering.purdue.edu/cdesign/wp/agentar/).

Tập `challenge` có 24 ca thuộc 8 nhóm ở hai trang tổng hợp mới. Tập này kiểm tra cụm chỉ thời gian cạnh tên dài hoặc tên được trích dẫn, đối tượng kích hoạt, tên trùng, thời gian và media. Giữ các biến thể cùng nhóm khi phân tích. Bộ tác vụ do trợ lý hỗ trợ soạn, cần tác giả hoặc giảng viên rà soát trước khi dùng làm đánh giá chính thức.

Prompt v3 qua cùng endpoint tự host và cùng nhãn mô hình `gpt-5.6-luna` cho 59/60 luồng đúng hành vi trên 90 ca cũ, với 12/12 ca hỏi lại và 18/18 ca ngoài phạm vi đúng nhãn. Cả 90 đầu ra hợp lệ ngay lượt đầu, nên A/B/C trùng kết quả. So với cấu hình C của v2, lượt gọi giảm từ 115 xuống 90, token giảm từ 271.944 xuống 225.600. Ca “hiện Thẻ ngay” đã chạy đúng. Ca không nêu đối tượng được chạm vẫn bị chấm lệch đáp án vì trợ lý hỏi lại. [Lượt đo v2](./test-selfhost-20261117-135619137.jsonl) · [Lượt đo v3](./retest-selfhost-v3-20261117-141711175.jsonl).

Tập mới đạt 11/12 luồng đúng hành vi, 9/9 ca hỏi lại và 3/3 ca ngoài phạm vi đúng nhãn, với 24 lượt gọi. Một ca xoay dùng `easeInOut` trong khi đáp án yêu cầu `linear`. Tập phát triển đạt 29/30 theo đáp án gốc với 30 lượt gọi. [Tập challenge](./challenge-selfhost-v3-20261117-141711175.jsonl) · [Tập phát triển](./dev-selfhost-v3-20261117-141413421.jsonl).

## Chạy benchmark

Studio dùng prompt `bookaria-editor-v11` cho trợ lý biên tập. Tác giả có thể tạo, nhân bản, cập nhật, xóa đối tượng trên trang và tạo, sửa hoặc xóa luồng trong một đề xuất. Tài nguyên dùng để thêm hoặc đổi phải thuộc danh sách có quyền sử dụng. Các thao tác xóa có bước xác nhận và được kiểm tra tham chiếu trước khi áp dụng. Mỗi lần áp dụng nằm trong lịch sử Undo/Redo chung của Studio; chat hiển thị trạng thái theo bản nháp hiện tại và hỗ trợ câu hỏi hướng dẫn bằng phản hồi answer. Quy trình tham khảo cách chọn tài nguyên và xác nhận các thao tác xóa trong [ReactVision Editor](https://aiindigo.com/tutorials/getting-started-with-reactvision-studio-rapid-prototyping-to-production-ready-co) và hướng dẫn [hỗ trợ sửa sai của Microsoft HAX](https://www.microsoft.com/en-us/haxtoolkit/guideline/support-efficient-correction/).

Bộ benchmark dưới đây đo phiên bản sinh một luồng tương tác. Để đánh giá trợ lý biên tập, cần thêm tác vụ có đáp án cho cả trạng thái ban đầu và hành vi, kèm trường hợp chọn sai phạm vi, đối tượng đang khóa và hoàn tác.

Kiểm tra nhanh prompt Studio v11 qua endpoint tự host đạt 7/7 ca tổng hợp ngay lượt đầu. Các ca gồm tạo chữ, đổi màu, sửa bước chờ trong phạm vi luồng hoặc khi gọi đúng tên luồng, tạo luồng mới, giải thích luồng và hỏi lại khi thiếu đối tượng kích hoạt. [Kết quả kiểm tra Studio](./editor-selfhost-v11-20261117-142710714.jsonl).

Cần ba repo backend/studio/viewer là các thư mục anh em như workspace hiện tại. Bộ chấm dùng `InteractionRunner` thật từ Viewer, clock ảo và executor ghi hiệu ứng. Không kiểm chứng render 3D, phát audio thật hoặc camera; phần đó cần chạy thử trình duyệt/thiết bị riêng.

```powershell
# Backend: xem số tác vụ/lượt gọi tối đa, không kết nối OpenAI
pnpm ai:benchmark --split=dev

# Sau khi cấu hình khóa, thử 3 tác vụ phát triển trước (có tính phí API)
pnpm ai:benchmark --run --split=dev --limit=3 --out=research/interaction-ai/pilot.jsonl

# Sau pilot và duyệt/khóa corpus, chạy dev hoặc test; tên output phải chưa tồn tại
pnpm ai:benchmark --run --split=test --repeats=3 --out=research/interaction-ai/test-run.jsonl

# Kiểm tra trên các tình huống và hai trang mới sau khi chốt prompt
pnpm ai:benchmark --run --split=challenge --out=research/interaction-ai/challenge-run.jsonl
```

Mặc định là dry-run. `--run` mới gọi mô hình thật. Mỗi tác vụ/lần lặp gọi tối đa **3 lần tổng cộng**: một lượt đầu chung, một thử lại B, một sửa C. Mỗi cấu hình A/B/C riêng chỉ dùng tối đa 1/2/2 lượt. Ba lần lặp của 90 test tối đa 810 lượt mô hình; thử pilot trước và kiểm tra hạn mức chi phí tài khoản. Công cụ không có tự resume, không ghi đè file đã có, dừng khi provider/evaluator lỗi và lưu dấu vết chưa hoàn chỉnh. Không bỏ qua lỗi rồi báo là chạy đủ test.

Manifest ghi thời gian, model yêu cầu, tham số, phiên bản Node, checksum corpus/prompt/provider/schema/runtime. Mỗi record chứa instruction, prompt thực gửi, đầu ra gốc, model thực trả, token, latency, lỗi validator và kết quả hành vi. Không chứa API key. Giữ JSONL làm dữ liệu gốc; không sửa kết quả sau khi đo.

## So sánh công bằng

- **A:** sinh một lần với schema và metadata có quyền sử dụng.
- **B:** cùng lượt đầu; nếu validator chặn thì gọi lại độc lập với prompt gốc, không đưa lỗi/đáp án.
- **C:** cùng lượt đầu; nếu validator chặn thì đưa đầu ra sai và danh sách lỗi để sửa một lần.
- Nếu lượt đầu đã qua validator, cả ba giữ cùng đầu ra, kể cả đầu ra sai hành vi hoặc từ chối nhầm. Không được dùng oracle để quyết định sửa.
- Giữ nguyên model/snapshot/tham số. Không dùng test để tối ưu prompt. Đáp án mong đợi không được đưa vào model.

`evaluate.mjs` bắn vào/rời trang và chạm từng đối tượng, so chuỗi hiệu ứng cùng thời điểm, thời gian tổng và trạng thái hiển thị. Nó gọi đôi sự kiện đồng thời để kiểm tra ignore-on-retrigger. So hiệu ứng thay vì JSON nguyên văn: ví dụ toggle và setVisible có thể tương đương trên cùng trạng thái ban đầu. Chuyển động chỉ kiểm lời gọi/tham số/thời lượng, không mô phỏng vật lý/render. Trạng thái hỏi lại/không hỗ trợ được chấm tự động theo nhãn; **nội dung câu hỏi làm rõ vẫn cần người đọc**, không báo nó là ngữ nghĩa đã được kiểm đầy đủ.

Self-check trong `benchmark.test.ts` dùng oracle tổng hợp để xác nhận công cụ chạy và cố tình đưa sai trigger, đối tượng, thời gian, thứ tự để xác nhận bộ chấm phát hiện lỗi. Đây **không phải benchmark mô hình**, dù self-check có thể qua tất cả tác vụ.

Khi CI chỉ checkout backend, các test schema/corpus/A-B-C vẫn chạy; hai test cần runtime Viewer được ghi rõ là skipped. Trong workspace ba repo, cả hai phải chạy và qua. CLI thực nghiệm kiểm tra tệp runtime trước khi gọi mô hình; không có fallback sang bộ chấm giả.

## Phân tích và bảng báo cáo

Tổng hợp ít nhất các cột sau theo A/B/C và theo nhóm: số tác vụ, tỷ lệ cấu trúc/khả năng hợp lệ, tỷ lệ **đề xuất thực thi đúng**, tỷ lệ trả lời đúng trạng thái trên tác vụ thiếu thông tin/ngoài phạm vi, latency, số lượt gọi, input/output token. Không gộp từ chối đúng vào tỷ lệ sinh thành công.

| Cấu hình | Đề xuất đúng hành vi | Xử lý thiếu thông tin/ngoài phạm vi | Độ trễ | Token/chi phí |
|---|---|---|---|---|
| A | Chưa đo | Chưa đo | Chưa đo | Chưa đo |
| B | Chưa đo | Chưa đo | Chưa đo | Chưa đo |
| C | Chưa đo | Chưa đo | Chưa đo | Chưa đo |

Token chưa có số đo phải là null, không ghi 0. Tính ước lượng USD từ số token và đơn giá đúng ngày/model; nếu bỏ qua cached-input discount thì ghi rõ là ước lượng theo giá không cache, không gọi là hóa đơn thực tế. Đối chiếu usage trên OpenAI khi báo tổng tiền. Chi phí triển khai từng cấu hình tính lượt đầu + lượt bổ sung của chính cấu hình; hóa đơn thực nghiệm chỉ tính lượt đầu một lần, không cộng lặp ba cấu hình.

Ba paraphrase và ba lần lặp không phải các mẫu độc lập. Khi tính khoảng tin cậy/bootstrap, gom theo **nhóm kịch bản**, không theo mỗi dòng. Với dữ liệu nhỏ, báo bảng lỗi và phân bố, tránh kết luận hơn kém chỉ từ một tỷ lệ. Nếu C chỉ làm JSON hợp lệ hơn nhưng hành vi không tốt hơn, đó là kết quả phải được ghi nhận.

## Đánh giá 8–12 tác giả trưởng thành

Chuẩn bị hai bộ tác vụ tương đương U/V, mỗi bộ có thao tác đơn, chuỗi thời gian và media. Người tham gia ít kinh nghiệm soạn tương tác, đồng ý tham gia và dùng mã ẩn danh. Dành cùng thời gian hướng dẫn cho mọi người. Không dùng trẻ em và không suy ra hiệu quả học tập.

Cân bằng bốn lịch: thủ công-U rồi AI-V; AI-U rồi thủ công-V; thủ công-V rồi AI-U; AI-V rồi thủ công-U. Phân bổ tuần tự theo mã người, mỗi lịch có 2–3 người nếu 8–12 người. Tránh cho một người làm lại đúng cùng nội dung hai lần. Cố định thời hạn mỗi tác vụ (ví dụ 5 phút) trước buổi đầu; ghi thất bại/hết giờ.

Phiếu thu thập: `participant_id, order, task_set, task_id, condition, completed_correctly, elapsed_seconds, manual_edits, generation_calls, notes`. Đo tới lúc hành vi được người quan sát xác nhận, không tới lúc AI trả JSON. Ghi lại sự cố mạng/provider riêng. Báo trung vị, độ phân tán và chênh lệch ghép cặp từng người; đây là nghiên cứu thăm dò, không mặc nhiên đủ lực thống kê.
