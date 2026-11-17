# Trợ lý biên tập tương tác Bookaria

Studio → Tương tác → nút logo **Tạo bằng AI** ở góc dưới phải → trao đổi trong chat → **Chạy thử** → áp dụng đề xuất → lưu sách như bình thường.

Chat dùng thành phần shadcn Message, Bubble, MessageScroller, Card và InputGroup. Trên desktop, chat là cửa sổ nổi ở góc phải dưới với nút mở rộng và thu nhỏ. Trên điện thoại, chat mở toàn màn hình. Chọn đối tượng/âm thanh bằng danh sách hoặc gõ `@`; các lựa chọn gửi ID để phân biệt đối tượng trùng tên. Khi AI hỏi lại, chọn câu trả lời gợi ý hoặc nhập tiếp. Có thể yêu cầu “đổi thành 5 giây” để sửa đề xuất hiện hành.

Đề xuất liệt kê các luồng được thêm hoặc sửa và thông tin ghi nhớ mới. Chọn **Thêm vào trang**, **Cập nhật luồng** hoặc **Áp dụng thay đổi** tùy đề xuất. Sau khi áp dụng đề xuất chỉ sửa một luồng, chat chọn luồng đó để bạn chỉnh tiếp. Chọn **Trang hiện tại** trong bộ chọn dưới ô nhập để đổi phạm vi. Khi đề xuất chỉ có một luồng, **Chạy thử** mở chế độ thử riêng luồng và có tùy chọn **Thử cả trang**. Mỗi lần áp dụng dùng một bước trong lịch sử Undo/Redo chung của Studio. Sau khi sửa tay, Undo sẽ lùi lần sửa tay gần nhất trước khi lùi phần AI đã áp dụng. Chat hiển thị trạng thái đã áp dụng, đã sửa tiếp hoặc đã hoàn tác. Đóng hoặc thu gọn chat hủy lượt đang chờ và giữ nội dung nhập để thử lại.

Trong **Thiết kế**, chọn **Trang hiện tại** để thêm đối tượng hoặc chọn đối tượng để giới hạn chỉnh sửa. Có thể yêu cầu “Thêm chữ Hãy là chính mình màu đen vào giữa trang”, chỉnh kiểu chữ, cỡ và căn lề nội dung thẻ, màu nền, viền, ảnh và nút của thẻ. Trợ lý cũng chỉnh độ hiện ảnh, phát tự động, lặp và âm lượng media, điều khiển và hoạt cảnh 3D, kích thước và gợi ý vùng chạm. Cỡ chữ riêng bên trong bong bóng, nhóm lớp, marker và thiết lập toàn sách được chỉnh trong Studio.

Lịch sử giữ trong bộ nhớ của phiên ứng dụng, theo tài khoản và trang (tối đa 50 trang). Tải lại trình duyệt sẽ mất lịch sử chat. Mỗi lượt gửi tối đa 20 tin gần nhất, đề xuất hiện hành và ngữ cảnh trang mới nhất. Khi chọn một luồng, mô hình nhận đầy đủ các bước của luồng đó và thông tin tóm tắt các luồng khác. Studio dùng `bookaria-editor-v11`. Bộ benchmark một luồng dùng `bookaria-interactions-v3`.

Ví dụ với đối tượng Rùa, thẻ Gợi ý và trang tiếp theo đã có sẵn: “Khi chạm Rùa, hỏi ‘Rùa biển sống ở đâu?’ với các lựa chọn ‘Biển’ và ‘Mặt Trăng’. Đáp án đúng là ‘Biển’. Nếu đúng, cộng 1 điểm và chuyển sang trang tiếp theo. Nếu sai, hiện thẻ Gợi ý.” Chạy thử hai lần để chọn cả hai đáp án. Xem trước sách để kiểm tra chuyển trang thực tế.

Trang mới phải được lưu ít nhất một lần để có quyền truy cập trên backend. Đối tượng/tương tác đang sửa có thể chưa lưu. AI không ghi database, không xuất bản và không tạo tài nguyên. Đề xuất không còn áp dụng được nếu trang, phiên bản hoặc danh sách tài nguyên thay đổi.

Bạn có thể hỏi “Giải thích luồng đang chọn”, “Tại sao bước sau chưa chạy?” hoặc “Hướng dẫn hoàn tác”. Phản hồi `answer` giải thích theo ngữ cảnh hiện có. Câu trả lời không thay trang và đề xuất đang chờ vẫn dùng được khi ngữ cảnh còn khớp.

Mô tả cấu trúc đầu ra bỏ metadata `$schema` để mô hình ít chép trường này vào kết quả. Backend tiếp tục kiểm tra schema nghiêm ngặt. Prompt hướng dẫn tách tên đối tượng khỏi từ chỉ thời gian và hỏi lại khi chưa rõ đối tượng được chạm. Các định nghĩa dùng chung giúp giảm ngữ cảnh mà vẫn giữ đủ hành động. Nếu vượt 64.000 ký tự, chat hướng dẫn chọn một luồng hoặc đối tượng trong **Phạm vi trao đổi** hoặc bắt đầu cuộc trò chuyện mới. Nếu đề xuất vẫn không hợp lệ sau một lần sửa, chat trả nguyên nhân từ bộ kiểm tra, chẳng hạn đối tượng đang khóa hoặc clip không tồn tại.

Khi AI đổi transform ban đầu của đối tượng có chuyển động lặp, Studio cập nhật điểm bắt đầu của mọi đoạn lặp bị ảnh hưởng trong cùng lần áp dụng. Undo/Redo khôi phục cả transform và điểm bắt đầu lặp. Các đích chuyển động, dây nối và bố cục luồng giữ nguyên.

## Cấu hình OpenAI

Chỉ đặt trên backend trong `.env` (không commit, không đặt khóa vào VITE_*):

```dotenv
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=<điền khóa API của bạn trên máy>
AI_MODEL=gpt-5.4-mini-2026-03-17
AI_TIMEOUT_MS=40000
```

Khởi động lại API sau khi đổi cấu hình. `AI_MODEL` trống hoặc thiếu khóa với endpoint từ xa sẽ trả `503 AI_UNAVAILABLE`; chức năng tạo tương tác thủ công vẫn dùng được. Snapshot trên là **ứng viên pilot**, chưa được chọn bằng benchmark. Tài khoản phải được phép dùng mô hình đó. Sau pilot trên dev, cố định model, prompt và tham số trước khi chạy test. [Tài liệu mô hình](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

Kết nối dùng `POST /v1/chat/completions`, JSON mode, tối đa 4096 completion token mỗi lượt, không stream, không tự retry lỗi mạng hoặc HTTP. JSON mode không chứng minh schema/ngữ nghĩa đúng; validator Bookaria chạy sau mỗi lượt. [API OpenAI](https://developers.openai.com/api/reference/resources/chat).

Mỗi yêu cầu sinh tối đa hai lượt mô hình, 60 yêu cầu/giờ/tài khoản, một yêu cầu đang chạy/tài khoản, tối đa hai yêu cầu đồng thời/API process. Mỗi lượt chờ tối đa `AI_TIMEOUT_MS` (1–120 giây). Giới hạn hiện dùng bộ nhớ: nếu chạy nhiều replica hoặc cần trần chi phí toàn hệ thống, chuyển sang bộ giới hạn dùng chung và cấu hình hạn mức tại OpenAI. Đóng hộp thoại/hủy yêu cầu sẽ abort việc chờ; nhà cung cấp vẫn có thể tính phí phần đã xử lý.

Backend gửi yêu cầu, tối đa 20 tin hội thoại gần nhất, đề xuất đang sửa, ID/tên/loại/transform/hiển thị của đối tượng và tên/loại/clip của tài nguyên đã kiểm quyền. Chế độ biên tập gửi thêm các luồng trên trang (gồm nội dung câu hỏi và liên kết nếu có), khai báo ghi nhớ, ID và tiêu đề các trang trong sách. Ngữ cảnh tự động loại URL tệp tài nguyên, ảnh trang, toàn văn sách, token người dùng và API key. Văn bản người dùng nhập và lịch sử hội thoại vẫn được gửi nguyên nội dung trong giới hạn độ dài. HTTP logs không chứa prompt hay phản hồi mô hình. Công cụ benchmark ghi prompt/đầu ra của dữ liệu tổng hợp vào tệp cục bộ để tái lập.

## Hợp đồng và phạm vi

`POST /api/v1/pages/:pageId/interaction-proposals`, xác thực Bearer như API hiện có.

```text
Input: { instruction, revision, scene, audioAssetIds?, history?, currentProposal?, editor?: { variables, currentPlan?, selectedRuleId? } }
200: { data: { status: "edit_plan", plan: { rules: [{ rule, replaceId? }], variables }, revision, usage } }
200: { data: { status: "proposal", rule, revision, usage } }  # chế độ một luồng khi không có editor
200: { data: { status: "needs_clarification" | "unsupported" | "invalid", message, choices?, revision, usage } }
```

`usage`: model trả về, promptVersion, attempts, latencyMs, inputTokens/outputTokens (`null` nếu nhà cung cấp không báo). Đây không phải hóa đơn chi phí.

- Chế độ biên tập đề xuất tối đa 6 luồng trên trang hiện tại, mỗi luồng tối đa 20 hành động. Hỗ trợ sự kiện và hành động có trong schema tương tác, bao gồm marker, cử chỉ, câu hỏi, nhánh điều kiện, biến/điểm và điều hướng. Chuyển trang chỉ dùng đích hợp lệ trong sách. Mọi liên kết ngoài mới phải là URL HTTP(S) tác giả đã nhập. Backend kiểm tra luồng, tài nguyên và tham chiếu sau khi ghép với bản nháp.
- Chế độ một luồng có 3 sự kiện (`onPageEnter`, `onPageLeave`, `onTap`) và 8 hành động (`playAudio`, `stopAudio`, `playAnimation`, `playVideo`, `setVisible`, `toggleVisible`, `transformTo`, `wait`). ID mới do chương trình tạo ở cả hai chế độ.
- `wait.ms` đặt thời gian chờ. Phát media bắt đầu phát và trả điều khiển cho luồng. Chuyển động và fade đợi hết duration rồi mới chạy bước kế. `transformTo` dùng tọa độ đích tuyệt đối, đơn vị chiều rộng trang, góc theo độ. Dừng audio thiếu `assetId` sẽ dừng toàn bộ audio. Đợi media phát xong, tạo tài nguyên và sửa luồng trên nhiều trang trong một lượt hiện ngoài phạm vi.
- Bộ kiểm tra xác nhận kế hoạch hợp lệ với bản nháp và runtime. Tác giả dùng **Chạy thử** để kiểm tra hành vi so với yêu cầu.

## Kiểm chứng và vận hành

- Backend: `pnpm exec vitest run src/modules/interaction-ai/__tests__`; có test database riêng theo global setup của repo, không ghi database phát triển.
- Studio: `pnpm exec tsx --test tests/ai-proposal.test.mjs` và `pnpm exec playwright test --config=playwright.interactions.config.mjs interaction-ai.spec.mjs`.
- Kiểm tra type/build/contract theo scripts có sẵn. Sau khi sửa schema chạy backend `pnpm contract:sync` và Studio `pnpm contract:sync`.
- Lỗi cấu hình/provider trả 503 với thông báo chung; rate limit trả 429; trang không thuộc tác giả trả 404; revision khác trả 409. Không tự gửi lại yêu cầu khi mất phản hồi.
- Rollback chức năng: để `AI_MODEL=` và khởi động lại API. Các rule tác giả đã chấp nhận vẫn là rule chuẩn và tiếp tục hoạt động; không cần migration database hoặc runtime Viewer mới.

Xem [quy trình thực nghiệm](../research/interaction-ai/README.md). Kiểm thử giả lập và self-check chỉ chứng minh đường chạy phần mềm; chưa chứng minh chất lượng mô hình hay giảm thời gian biên soạn.

### Kết quả kiểm tra triển khai — 15/11/2026

- Backend: `pnpm check` thành công, 71 tệp / 725 test; production build thành công. Sau thay đổi hỗ trợ CI checkout backend riêng, 5 test benchmark được chạy lại và đều qua trong workspace có Viewer.
- Studio: kiểm tra TypeScript, 494 test và production build thành công; 5 test trình duyệt của trợ lý AI thành công với API mô phỏng. Biome còn cảnh báo có sẵn; build còn cảnh báo chunk lớn hơn 500 kB.
- Benchmark chạy thử không gọi API: 30 tác vụ dev, 90 tác vụ test; chưa có kết quả A/B/C từ mô hình thật. Bộ 120 tác vụ là bản tổng hợp cần người rà soát.
- Chưa gọi OpenAI vì `AI_API_KEY` chưa được cấu hình trên máy; chưa tiến hành đánh giá người dùng hoặc đo hiệu quả thực tế.

### Kiểm tra bản chat — 16/11/2026

- TypeScript backend và production build Studio thành công; contract được đồng bộ.
- 42 test backend AI và 3 test Studio về áp dụng/cập nhật/hoàn tác thành công.
- 9 kịch bản trình duyệt thành công qua các lượt kiểm tra: hỏi lại, chỉnh luồng đã áp dụng, hoàn tác, preview, stale context, lỗi/thử lại, hủy, mobile/Escape, chọn tham chiếu và giữ nội dung theo trang (một số kịch bản kiểm tra nhiều hành vi).
- Các lượt AI trong kiểm thử dùng phản hồi mô phỏng. Chưa đo chất lượng hội thoại với OpenAI thật hoặc người dùng.

### Kiểm tra bản biên tập thử nghiệm

- 50 test backend AI, 3 test kiểm tra áp dụng/hoàn tác và 8 test Chrome dùng phản hồi mô phỏng đã qua. Bản build backend, Studio và Viewer đã qua. Test Chrome xác nhận cả hai nhánh câu hỏi, điểm trong lúc chạy thử, điều hướng mô phỏng, áp dụng và hoàn tác một nhóm luồng.
- Hai tác vụ tổng hợp được gửi qua endpoint tương thích OpenAI đang cấu hình. Phản hồi mang tên mô hình `gpt-5.6-luna`. Mô hình sinh được cấu trúc hỏi đáp có hai nhánh và sửa đúng luồng đang chọn trong hai luồng trùng tên. Còn cần đánh giá A/B/C và đánh giá người dùng.
