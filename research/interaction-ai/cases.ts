import type { GenerationContext } from '../../src/modules/interaction-ai/generation';
import { type Action, SceneSchema, type Trigger } from '../../src/schema/scene.schema';

// Draft benchmark authored for this project; review before freezing a model evaluation.
// Three phrasings stay in the same scenario group and split, never counted as independent groups.
const audio = '11111111-1111-4111-8111-111111111111';
const music = '22222222-2222-4222-8222-222222222222';
const model = '33333333-3333-4333-8333-333333333333';
const video = '44444444-4444-4444-8444-444444444444';
const enter: Trigger = { type: 'onPageEnter' },
    leave: Trigger = { type: 'onPageLeave' },
    tap: Trigger = { type: 'onTap', objectId: 'hero' };
const show = (value: boolean, objectId = 'card', durationMs = 0) =>
    ({ type: 'setVisible', objectId, value, durationMs, delayMsSchema: 0 }) as const;
const wait = (ms: number) => ({ type: 'wait', ms }) as const;
const play = (assetId = audio, loop = false, volume = 1) =>
    ({ type: 'playAudio', assetId, loop, volume, delayMsSchema: 0 }) as const;
const stop = (assetId?: string) =>
    ({ type: 'stopAudio', ...(assetId ? { assetId } : {}), delayMsSchema: 0 }) as const;
const animation = (loop = false) =>
    ({ type: 'playAnimation', objectId: 'hero', clip: 'Walk', loop, delayMsSchema: 0 }) as const;
const playVideo = { type: 'playVideo', objectId: 'film', delayMsSchema: 0 } as const;
const toggle = {
    type: 'toggleVisible',
    objectId: 'card',
    durationMs: 0,
    delayMsSchema: 0,
} as const;
const move = (position: [number, number, number], durationMs = 500) =>
    ({
        type: 'transformTo',
        objectId: 'hero',
        position,
        durationMs,
        easing: 'easeInOut',
        delayMsSchema: 0,
    }) as const;
type Spec = {
    group: string;
    split: 'dev' | 'test';
    prompts: [string, string, string];
    trigger?: Trigger;
    actions?: Action[];
    status?: 'needs_clarification' | 'unsupported';
    duplicate?: boolean;
    missingAudio?: boolean;
    missingClip?: boolean;
};
const specs: Spec[] = [
    {
        group: 'dev-show-enter',
        split: 'dev',
        trigger: enter,
        actions: [show(true)],
        prompts: [
            'Vào trang thì hiện Thẻ ngay.',
            'Ngay khi mở trang, cho Thẻ xuất hiện tức thì.',
            'Tạo sự kiện vào trang làm hiện Thẻ, không hiệu ứng chuyển.',
        ],
    },
    {
        group: 'dev-hide-tap',
        split: 'dev',
        trigger: tap,
        actions: [show(false)],
        prompts: [
            'Chạm Rùa thì ẩn Thẻ ngay.',
            'Khi bấm Rùa, tắt hiển thị Thẻ tức thì.',
            'Cho thao tác chạm vào Rùa làm Thẻ biến mất ngay.',
        ],
    },
    {
        group: 'dev-audio-enter',
        split: 'dev',
        trigger: enter,
        actions: [play()],
        prompts: [
            'Vào trang phát Lời đọc một lần, âm lượng 100%.',
            'Khi mở trang, bắt đầu Lời đọc không lặp, âm lượng đầy đủ.',
            'Tự phát Lời đọc ở mức 1 lúc vào trang, không lặp.',
        ],
    },
    {
        group: 'dev-stop-leave',
        split: 'dev',
        trigger: leave,
        actions: [stop()],
        prompts: [
            'Rời trang dừng tất cả âm thanh.',
            'Khi thoát trang này, tắt toàn bộ tiếng đang phát.',
            'Tạo luồng rời trang để ngừng mọi audio của trang.',
        ],
    },
    {
        group: 'dev-video-tap',
        split: 'dev',
        trigger: tap,
        actions: [playVideo],
        prompts: [
            'Chạm Rùa để phát Phim.',
            'Bấm vào Rùa thì bắt đầu video Phim.',
            'Khi người đọc chạm Rùa, chạy video tên Phim.',
        ],
    },
    {
        group: 'dev-animation-tap',
        split: 'dev',
        trigger: tap,
        actions: [animation()],
        prompts: [
            'Chạm Rùa chạy clip Walk một lần.',
            'Bấm Rùa cho Rùa phát hoạt ảnh Walk không lặp.',
            'Khi chạm vào Rùa, bắt đầu animation Walk của Rùa, không lặp.',
        ],
    },
    {
        group: 'dev-toggle-tap',
        split: 'dev',
        trigger: tap,
        actions: [toggle],
        prompts: [
            'Chạm Rùa thì đảo trạng thái hiện ẩn Thẻ ngay.',
            'Bấm Rùa: Thẻ đang hiện thì ẩn, đang ẩn thì hiện, tức thì.',
            'Cho thao tác chạm Rùa bật tắt hiển thị Thẻ, không fade.',
        ],
    },
    {
        group: 'dev-absolute-move',
        split: 'dev',
        trigger: tap,
        actions: [move([0.3, 0, 0], 1000)],
        prompts: [
            'Chạm Rùa đưa Rùa tới tọa độ [0.3,0,0] trong 1 giây, easeInOut.',
            'Bấm Rùa để vị trí đích của Rùa là X=0.3 Y=0 Z=0, chuyển 1000 ms easeInOut.',
            'Khi chạm, di chuyển Rùa về [0.3,0,0], thời lượng 1 giây với easeInOut.',
        ],
    },
    {
        group: 'dev-timed-card',
        split: 'dev',
        trigger: enter,
        actions: [show(true), wait(2000), show(false)],
        prompts: [
            'Vào trang hiện Thẻ ngay, chờ 2 giây rồi ẩn ngay.',
            'Khi mở trang, bật Thẻ tức thì trong 2000 ms rồi tắt tức thì.',
            'Cho Thẻ hiện ngay lúc vào trang, sau đó đợi hai giây và ẩn Thẻ không fade.',
        ],
    },
    {
        group: 'dev-missing-target',
        split: 'dev',
        status: 'needs_clarification',
        prompts: [
            'Chạm Rùa thì hiện Ngôi sao.',
            'Cho đối tượng Ngôi sao xuất hiện khi chạm Rùa.',
            'Bấm Rùa để hiện đối tượng có tên Ngôi sao ngay.',
        ],
    },
    {
        group: 'test-narrated-card',
        split: 'test',
        trigger: tap,
        actions: [show(true), play(), wait(3000), show(false)],
        prompts: [
            'Chạm Rùa hiện Thẻ ngay, bắt đầu Lời đọc một lần âm lượng 100%, chờ 3 giây rồi ẩn Thẻ ngay.',
            'Bấm Rùa: bật Thẻ tức thì rồi phát Lời đọc không lặp mức 1; sau 3000 ms tắt Thẻ tức thì.',
            'Khi chạm Rùa, cho Thẻ xuất hiện không fade, phát Lời đọc đầy đủ âm lượng không lặp, đợi ba giây rồi ẩn Thẻ.',
        ],
    },
    {
        group: 'test-delayed-video',
        split: 'test',
        trigger: enter,
        actions: [wait(1500), playVideo],
        prompts: [
            'Vào trang đợi 1.5 giây rồi phát Phim.',
            'Mở trang được 1500 ms thì bắt đầu video Phim.',
            'Chỉ bắt đầu Phim sau khi vào trang và chờ một giây rưỡi.',
        ],
    },
    {
        group: 'test-fade-then-wait',
        split: 'test',
        trigger: tap,
        actions: [show(true, 'card', 500), wait(1000), show(false, 'card', 250)],
        prompts: [
            'Chạm Rùa hiện Thẻ bằng fade 500 ms, hiện xong chờ 1 giây rồi ẩn bằng fade 250 ms.',
            'Bấm Rùa: Thẻ hiện dần trong nửa giây, đợi thêm 1000 ms sau fade rồi mờ đi 250 ms.',
            'Khi chạm Rùa, fade-in Thẻ 0.5 giây; hoàn tất mới chờ một giây và fade-out 0.25 giây.',
        ],
    },
    {
        group: 'test-specific-audio-stop',
        split: 'test',
        trigger: tap,
        actions: [play(), wait(2500), stop(audio)],
        prompts: [
            'Chạm Rùa phát Lời đọc một lần mức 1, đợi 2.5 giây rồi chỉ dừng Lời đọc.',
            'Bấm Rùa bắt đầu Lời đọc không lặp âm lượng 100%, sau 2500 ms tắt riêng âm thanh đó.',
            'Khi chạm Rùa, phát Lời đọc mức đầy đủ không lặp, chờ hai giây rưỡi và dừng nó, giữ các audio khác.',
        ],
    },
    {
        group: 'test-replace-music',
        split: 'test',
        trigger: enter,
        actions: [stop(music), play()],
        prompts: [
            'Vào trang dừng riêng Nhạc nền, rồi phát Lời đọc một lần mức 1.',
            'Mở trang thì tắt Nhạc nền và bắt đầu Lời đọc 100% âm lượng không lặp.',
            'Khi vào trang, ngừng audio Nhạc nền trước, sau đó phát Lời đọc không lặp âm lượng đầy đủ.',
        ],
    },
    {
        group: 'test-two-card-sequence',
        split: 'test',
        trigger: tap,
        actions: [show(false), show(true, 'hint')],
        prompts: [
            'Chạm Rùa ẩn Thẻ ngay rồi hiện Gợi ý ngay.',
            'Bấm Rùa để tắt Thẻ tức thì, sau đó bật Gợi ý tức thì.',
            'Khi chạm Rùa, thay hiển thị Thẻ bằng Gợi ý: ẩn Thẻ rồi hiện Gợi ý, không fade.',
        ],
    },
    {
        group: 'test-animation-with-audio',
        split: 'test',
        trigger: tap,
        actions: [animation(true), play()],
        prompts: [
            'Chạm Rùa bắt đầu Walk lặp, rồi phát Lời đọc một lần mức 1 ngay, không chờ animation kết thúc.',
            'Bấm Rùa chạy Walk liên tục và ngay sau khi bắt đầu, phát Lời đọc không lặp âm lượng đầy đủ.',
            'Khi chạm Rùa, khởi động clip Walk lặp của Rùa rồi bắt đầu Lời đọc mức 100% không lặp.',
        ],
    },
    {
        group: 'test-move-and-show',
        split: 'test',
        trigger: enter,
        actions: [move([0, 0.2, 0], 1000), show(true)],
        prompts: [
            'Vào trang di chuyển Rùa tới [0,0.2,0] trong 1 giây easeInOut, đến nơi mới hiện Thẻ ngay.',
            'Khi mở trang đưa Rùa về X=0 Y=0.2 Z=0 bằng easeInOut 1000 ms rồi bật Thẻ tức thì.',
            'Rùa chuyển đến [0,0.2,0] với easeInOut một giây lúc vào trang; hoàn thành thì cho Thẻ xuất hiện ngay.',
        ],
    },
    {
        group: 'test-relative-move-wait',
        split: 'test',
        trigger: tap,
        actions: [wait(1000), move([0.1, 0, 0], 500)],
        prompts: [
            'Chạm Rùa chờ 1 giây, dịch Rùa sang phải 0.3 chiều rộng trang từ vị trí hiện tại trong 500 ms easeInOut.',
            'Bấm Rùa rồi đợi 1000 ms, tăng tọa độ X của Rùa thêm 0.3, giữ Y Z, chuyển nửa giây easeInOut.',
            'Khi chạm Rùa: chờ một giây; đưa Rùa sang phải thêm 0.3 đơn vị so với vị trí hiện tại, 0.5 giây easeInOut.',
        ],
    },
    {
        group: 'test-scale-with-audio',
        split: 'test',
        trigger: tap,
        actions: [
            {
                type: 'transformTo',
                objectId: 'hero',
                scale: [2, 2, 2],
                durationMs: 1000,
                easing: 'easeInOut',
                delayMsSchema: 0,
            },
            play(),
        ],
        prompts: [
            'Chạm Rùa đổi scale Rùa tới [2,2,2] trong 1 giây easeInOut, xong phát Lời đọc một lần mức 1.',
            'Bấm Rùa phóng scale thành 2 trên cả ba trục trong 1000 ms easeInOut rồi phát Lời đọc 100% không lặp.',
            'Khi chạm, scale Rùa tới [2,2,2] bằng easeInOut một giây; hoàn tất mới bắt đầu Lời đọc mức 1 không lặp.',
        ],
    },
    {
        group: 'test-rotation-and-hide',
        split: 'test',
        trigger: tap,
        actions: [
            {
                type: 'transformTo',
                objectId: 'hero',
                rotation: [0, 0, 90],
                durationMs: 2000,
                easing: 'easeInOut',
                delayMsSchema: 0,
            },
            show(false, 'hero'),
        ],
        prompts: [
            'Chạm Rùa xoay góc đích [0,0,90] độ trong 2 giây easeInOut, xong ẩn Rùa ngay.',
            'Bấm Rùa đưa rotation của nó về X=0 Y=0 Z=90 độ, 2000 ms easeInOut rồi tắt hiển thị Rùa tức thì.',
            'Khi chạm Rùa, xoay nó đến [0,0,90] với easeInOut hai giây rồi cho Rùa biến mất ngay.',
        ],
    },
    {
        group: 'test-volume-loop-stop',
        split: 'test',
        trigger: enter,
        actions: [play(music, true, 0.25), wait(5000), stop(music)],
        prompts: [
            'Vào trang phát Nhạc nền lặp âm lượng 25%, chờ 5 giây rồi dừng riêng Nhạc nền.',
            'Mở trang chạy Nhạc nền loop mức 0.25, đợi 5000 ms và tắt audio đó.',
            'Khi vào trang, bắt đầu Nhạc nền lặp một phần tư âm lượng, sau năm giây ngừng riêng bản nhạc này.',
        ],
    },
    {
        group: 'test-leave-hide-stop',
        split: 'test',
        trigger: leave,
        actions: [show(false), stop()],
        prompts: [
            'Rời trang ẩn Thẻ ngay rồi dừng mọi âm thanh.',
            'Khi thoát trang, tắt Thẻ tức thì trước, tiếp theo ngừng toàn bộ audio.',
            'Tạo luồng rời trang: cho Thẻ biến mất không fade và dừng tất cả tiếng.',
        ],
    },
    {
        group: 'test-tap-card-video',
        split: 'test',
        trigger: { type: 'onTap', objectId: 'card' },
        actions: [show(true, 'film'), playVideo],
        prompts: [
            'Chạm Thẻ hiện Phim ngay rồi bắt đầu phát Phim.',
            'Bấm lên Thẻ để bật hiển thị video Phim tức thì rồi chạy video.',
            'Khi người đọc chạm Thẻ, cho đối tượng Phim xuất hiện không fade và phát nó.',
        ],
    },
    {
        group: 'test-video-then-hide',
        split: 'test',
        trigger: tap,
        actions: [playVideo, wait(4000), show(false, 'film')],
        prompts: [
            'Chạm Rùa phát Phim, chờ đúng 4 giây rồi ẩn Phim ngay, không đợi video kết thúc.',
            'Bấm Rùa bắt đầu Phim; sau 4000 ms kể từ lúc phát thì tắt hiển thị Phim tức thì.',
            'Khi chạm Rùa, chạy video Phim rồi đợi bốn giây và ẩn video không fade.',
        ],
    },
    {
        group: 'test-toggle-twice',
        split: 'test',
        trigger: tap,
        actions: [toggle, wait(750), toggle],
        prompts: [
            'Chạm Rùa đảo hiển thị Thẻ ngay, chờ 750 ms rồi đảo lần nữa ngay.',
            'Bấm Rùa bật/tắt Thẻ tức thì, sau 0.75 giây bật/tắt nó lần nữa.',
            'Khi chạm Rùa, toggle Thẻ không fade, đợi ba phần tư giây rồi toggle lại không fade.',
        ],
    },
    {
        group: 'test-delayed-animation',
        split: 'test',
        trigger: enter,
        actions: [wait(2000), animation(true)],
        prompts: [
            'Vào trang đợi 2 giây rồi cho Rùa chạy Walk lặp.',
            'Mở trang được 2000 ms mới bắt đầu clip Walk liên tục trên Rùa.',
            'Khi vào trang, chờ hai giây sau đó phát animation Walk của Rùa với chế độ lặp.',
        ],
    },
    {
        group: 'test-two-audio',
        split: 'test',
        trigger: tap,
        actions: [play(music, true, 0.2), play()],
        prompts: [
            'Chạm Rùa bắt đầu Nhạc nền lặp mức 20%, rồi ngay lập tức bắt đầu Lời đọc một lần mức 100%.',
            'Bấm Rùa phát Nhạc nền loop âm lượng 0.2, sau khi khởi động phát Lời đọc mức 1 không lặp.',
            'Khi chạm Rùa: chạy Nhạc nền lặp một phần năm âm lượng; kế tiếp phát Lời đọc không lặp đầy đủ âm lượng, không chờ nhạc kết thúc.',
        ],
    },
    {
        group: 'test-three-stages',
        split: 'test',
        trigger: enter,
        actions: [
            show(true),
            wait(1000),
            show(false),
            show(true, 'hint'),
            wait(2000),
            show(false, 'hint'),
        ],
        prompts: [
            'Vào trang hiện Thẻ ngay, chờ 1 giây, ẩn Thẻ ngay, hiện Gợi ý ngay, chờ 2 giây rồi ẩn Gợi ý ngay.',
            'Mở trang bật Thẻ tức thì trong 1000 ms rồi tắt; tiếp theo bật Gợi ý tức thì trong 2000 ms rồi tắt.',
            'Khi vào trang, hiển thị Thẻ không fade một giây; ẩn nó, hiện Gợi ý không fade hai giây rồi ẩn Gợi ý không fade.',
        ],
    },
    {
        group: 'test-move-reset',
        split: 'test',
        trigger: tap,
        actions: [move([0.4, 0, 0], 1000), wait(1000), move([-0.2, 0, 0], 1000)],
        prompts: [
            'Chạm Rùa chuyển đến [0.4,0,0] một giây easeInOut, chờ một giây rồi về [-0.2,0,0] một giây easeInOut.',
            'Bấm Rùa: đi tới X=0.4 Y=0 Z=0 trong 1000 ms, đợi 1000 ms, trở lại X=-0.2 Y=0 Z=0 trong 1000 ms; hai chuyển động easeInOut.',
            'Khi chạm Rùa, đưa nó đến [0.4,0,0] với easeInOut 1 giây, dừng 1 giây rồi trở về [-0.2,0,0] với easeInOut 1 giây.',
        ],
    },
    {
        group: 'test-duplicate-name',
        split: 'test',
        status: 'needs_clarification',
        duplicate: true,
        prompts: [
            'Chạm Rùa thì hiện Thẻ ngay.',
            'Bấm Rùa để bật Thẻ tức thì.',
            'Tạo luồng khi chạm đối tượng tên Rùa làm xuất hiện Thẻ.',
        ],
    },
    {
        group: 'test-missing-audio',
        split: 'test',
        status: 'needs_clarification',
        missingAudio: true,
        prompts: [
            'Chạm Rùa phát Lời đọc.',
            'Khi bấm Rùa, bắt đầu audio Lời đọc.',
            'Phát tệp Lời đọc khi người xem chạm vào Rùa.',
        ],
    },
    {
        group: 'test-missing-clip',
        split: 'test',
        status: 'needs_clarification',
        missingClip: true,
        prompts: [
            'Chạm Rùa chạy animation Walk.',
            'Bấm vào Rùa để Rùa phát clip Walk.',
            'Cho sự kiện chạm Rùa bắt đầu hoạt ảnh Walk trên Rùa.',
        ],
    },
    {
        group: 'test-vague-distance',
        split: 'test',
        status: 'needs_clarification',
        prompts: [
            'Chạm Rùa cho Rùa đi sang phải một chút.',
            'Bấm Rùa rồi dịch nó qua bên phải một đoạn.',
            'Khi chạm, đưa Rùa sang phải vừa phải.',
        ],
    },
    {
        group: 'test-await-audio-end',
        split: 'test',
        status: 'unsupported',
        prompts: [
            'Phát Lời đọc khi vào trang, đọc xong mới hiện Thẻ.',
            'Vào trang bắt đầu Lời đọc, đợi audio kết thúc rồi hiện Thẻ.',
            'Khi mở trang, cho Lời đọc chạy hết tệp sau đó mới bật Thẻ.',
        ],
    },
    {
        group: 'test-branch',
        split: 'test',
        status: 'unsupported',
        prompts: [
            'Chạm Rùa nếu điểm lớn hơn 3 thì hiện Thẻ, nếu không thì phát Lời đọc.',
            'Bấm Rùa kiểm tra điểm: trên 3 hiện Thẻ, còn lại phát Lời đọc.',
            'Tạo nhánh theo điểm khi chạm Rùa: điểm > 3 bật Thẻ, ngược lại chạy Lời đọc.',
        ],
    },
    {
        group: 'test-generate-object',
        split: 'test',
        status: 'unsupported',
        prompts: [
            'Tạo mô hình 3D con Cáo rồi chạm Cáo phát Lời đọc.',
            'Sinh thêm nhân vật Cáo 3D và gắn thao tác chạm để đọc.',
            'Dựng một đối tượng Cáo ba chiều mới, cho bấm vào nó phát Lời đọc.',
        ],
    },
    {
        group: 'test-navigation',
        split: 'test',
        status: 'unsupported',
        prompts: [
            'Chạm Rùa chuyển sang trang tiếp theo.',
            'Bấm Rùa để mở trang sau của sách.',
            'Cho thao tác chạm Rùa điều hướng tới trang kế tiếp.',
        ],
    },
    {
        group: 'test-marker-trigger',
        split: 'test',
        status: 'unsupported',
        prompts: [
            'Nhận diện được marker thì hiện Thẻ.',
            'Khi camera tìm thấy ảnh AR, bật Thẻ.',
            'Cho sự kiện marker found làm Thẻ xuất hiện.',
        ],
    },
    {
        group: 'test-quiz',
        split: 'test',
        status: 'unsupported',
        prompts: [
            'Chạm Rùa hỏi một câu trắc nghiệm về rùa.',
            'Tạo câu hỏi đúng sai khi người đọc bấm Rùa.',
            'Bấm Rùa để mở quiz có bốn đáp án.',
        ],
    },
];

export type BenchmarkCase = {
    id: string;
    group: string;
    split: 'dev' | 'test' | 'challenge';
    instruction: string;
    context: GenerationContext;
    expected:
        | { status: 'proposal'; trigger: Trigger; actions: Action[] }
        | { status: 'needs_clarification' | 'unsupported' };
};
function contextFor(spec: Spec): GenerationContext {
    const scene = SceneSchema.parse({
        schemaVersion: 1,
        objects: [
            {
                id: 'hero',
                type: 'model',
                name: 'Rùa',
                assetId: model,
                transform: { position: [-0.2, 0, 0] },
            },
            {
                id: 'card',
                type: 'text',
                name: 'Thẻ',
                text: 'Thông tin',
                visible: false,
                transform: {},
            },
            {
                id: 'hint',
                type: 'text',
                name: 'Gợi ý',
                text: 'Gợi ý',
                visible: false,
                transform: {},
            },
            { id: 'film', type: 'video', name: 'Phim', assetId: video, transform: {} },
            ...(spec.duplicate
                ? [
                      {
                          id: 'second-hero',
                          type: 'model',
                          name: 'Rùa',
                          assetId: model,
                          transform: { position: [0.2, 0, 0] },
                      },
                  ]
                : []),
        ],
    });
    return {
        scene,
        assets: [
            { id: model, type: 'MODEL', name: 'Rùa', animations: spec.missingClip ? [] : ['Walk'] },
            { id: video, type: 'VIDEO', name: 'Phim', animations: [] },
            { id: music, type: 'AUDIO', name: 'Nhạc nền', animations: [] },
            ...(spec.missingAudio
                ? []
                : [{ id: audio, type: 'AUDIO', name: 'Lời đọc', animations: [] }]),
        ],
    };
}
export const cases: BenchmarkCase[] = specs.flatMap((spec) =>
    spec.prompts.map((instruction, index) => ({
        id: `${spec.group}-${index + 1}`,
        group: spec.group,
        split: spec.split,
        instruction,
        context: contextFor(spec),
        expected: spec.status
            ? { status: spec.status }
            : {
                  status: 'proposal',
                  trigger: spec.trigger as Trigger,
                  actions: spec.actions as Action[],
              },
    })),
);
