import type { GenerationContext } from '../../src/modules/interaction-ai/generation';
import { ActionSchema, SceneSchema, type Trigger } from '../../src/schema/scene.schema';
import type { BenchmarkCase } from './cases';

const telescope = '55111111-1111-4111-8111-111111111111';
const recording = '55222222-2222-4222-8222-222222222222';
const clip = '55333333-3333-4333-8333-333333333333';
const audio = '55444444-4444-4444-8444-444444444444';

const observatory: GenerationContext = {
    scene: SceneSchema.parse({
        schemaVersion: 1,
        objects: [
            {
                id: 'scope',
                type: 'model',
                name: 'Kính thiên văn',
                assetId: telescope,
                transform: {},
            },
            {
                id: 'orbit',
                type: 'text',
                name: 'Sơ đồ quỹ đạo',
                text: 'Quỹ đạo',
                transform: {},
                visible: false,
            },
            { id: 'eclipse', type: 'video', name: 'Phim nhật thực', assetId: clip, transform: {} },
            { id: 'panel', type: 'hotspot', name: 'Nút quan sát', transform: {} },
        ],
    }),
    assets: [
        { id: telescope, name: 'Kính thiên văn', type: 'MODEL', animations: ['Align'] },
        { id: recording, name: 'Thuyết minh', type: 'AUDIO', animations: [] },
        { id: clip, name: 'Phim nhật thực', type: 'VIDEO', animations: [] },
    ],
};

const museum: GenerationContext = {
    scene: SceneSchema.parse({
        schemaVersion: 1,
        objects: [
            { id: 'bell', type: 'hotspot', name: 'Chuông', transform: {} },
            { id: 'guide', type: 'text', name: 'Bảng chỉ đường', text: 'Lối vào', transform: {} },
            {
                id: 'today',
                type: 'text',
                name: 'Lịch hôm nay',
                text: 'Lịch',
                transform: {},
                visible: false,
            },
            {
                id: 'lantern-west',
                type: 'hotspot',
                name: 'Đèn lồng',
                transform: { position: [-0.3, 0, 0] },
            },
            {
                id: 'lantern-east',
                type: 'hotspot',
                name: 'Đèn lồng',
                transform: { position: [0.3, 0, 0] },
            },
        ],
    }),
    assets: [{ id: audio, name: 'Tiếng chuông', type: 'AUDIO', animations: [] }],
};

type Scenario = {
    group: string;
    context: GenerationContext;
    prompts: [string, string, string];
    expected: BenchmarkCase['expected'];
};

const proposal = (trigger: Trigger, ...actions: unknown[]): BenchmarkCase['expected'] => ({
    status: 'proposal',
    trigger,
    actions: actions.map((action) => ActionSchema.parse(action)),
});
const tap = (objectId: string) => ({ type: 'onTap', objectId }) as const;
const visible = (objectId: string, value: boolean, durationMs = 0) => ({
    type: 'setVisible',
    objectId,
    value,
    durationMs,
});
const wait = (ms: number) => ({ type: 'wait', ms });

const scenarios: Scenario[] = [
    {
        group: 'challenge-observatory-clip-fade',
        context: observatory,
        prompts: [
            'Bấm Nút quan sát, chạy Align trên Kính thiên văn một lần. Ngay sau khi bắt đầu clip, hiện Sơ đồ quỹ đạo dần trong 400 ms.',
            'Chạm Nút quan sát thì phát hoạt cảnh Align của Kính thiên văn, không lặp. Không đợi hết clip, cho Sơ đồ quỹ đạo hiện dần trong 0,4 giây.',
            'Lấy Nút quan sát làm chỗ bấm: khởi động Align một lần trên Kính thiên văn rồi lập tức fade-in Sơ đồ quỹ đạo 400 ms.',
        ],
        expected: proposal(
            tap('panel'),
            { type: 'playAnimation', objectId: 'scope', clip: 'Align', loop: false },
            visible('orbit', true, 400),
        ),
    },
    {
        group: 'challenge-museum-audio-calendar',
        context: museum,
        prompts: [
            'Bấm Chuông để phát Tiếng chuông một lần ở 50%; sau nửa giây hiện Lịch hôm nay ngay, chờ 2 giây nữa rồi ẩn lịch ngay.',
            'Chạm Chuông thì bật Tiếng chuông mức 0,5 không lặp. Đợi 500 ms, bật “Lịch hôm nay” tức thì; đợi thêm 2000 ms rồi tắt lịch tức thì.',
            'Nhấn Chuông, phát Tiếng chuông không lặp ở nửa âm lượng, đợi nửa giây rồi cho “Lịch hôm nay” hiện không fade; hai giây sau cho lịch biến mất tức thì.',
        ],
        expected: proposal(
            tap('bell'),
            { type: 'playAudio', assetId: audio, loop: false, volume: 0.5 },
            wait(500),
            visible('today', true),
            wait(2000),
            visible('today', false),
        ),
    },
    {
        group: 'challenge-museum-timing-adverb',
        context: museum,
        prompts: [
            'Rời trang ẩn Bảng chỉ đường ngay, chờ 1,2 giây rồi dừng riêng Tiếng chuông.',
            'Lúc thoát trang tắt Bảng chỉ đường tức thì; 1200 ms sau ngừng mỗi Tiếng chuông thôi.',
            'Khi rời trang, giấu “Bảng chỉ đường” ngay lập tức rồi đợi 1.2 giây và chỉ tắt Tiếng chuông.',
        ],
        expected: proposal({ type: 'onPageLeave' }, visible('guide', false), wait(1200), {
            type: 'stopAudio',
            assetId: audio,
        }),
    },
    {
        group: 'challenge-observatory-orient-then-narrate',
        context: observatory,
        prompts: [
            'Khi mở trang, xoay Kính thiên văn tới góc đích [0,30,0] độ trong 750 ms tuyến tính, xong thì phát Thuyết minh không lặp âm lượng 80%.',
            'Vào trang đặt hướng Kính thiên văn X=0 Y=30 Z=0 độ, mất 0.75 giây, linear. Xoay xong mới bật Thuyết minh một lần mức 0.8.',
            'Mở trang: đưa Kính thiên văn tới [0,30,0] độ đều trong ba phần tư giây; khi xong, bắt đầu Thuyết minh một lần ở 80 phần trăm.',
        ],
        expected: proposal(
            { type: 'onPageEnter' },
            {
                type: 'transformTo',
                objectId: 'scope',
                rotation: [0, 30, 0],
                durationMs: 750,
                easing: 'linear',
            },
            { type: 'playAudio', assetId: recording, loop: false, volume: 0.8 },
        ),
    },
    {
        group: 'challenge-observatory-missing-trigger',
        context: observatory,
        prompts: [
            'Khi chạm, cho Phim nhật thực chạy.',
            'Sau thao tác bấm, bắt đầu video Phim nhật thực.',
            'Làm sao để khi người đọc nhấn vào một đối tượng, Phim nhật thực bắt đầu phát?',
        ],
        expected: { status: 'needs_clarification' },
    },
    {
        group: 'challenge-museum-duplicate-trigger',
        context: museum,
        prompts: [
            'Chạm Đèn lồng rồi đợi nửa giây mới ẩn Bảng chỉ đường ngay.',
            'Bấm vào Đèn lồng, chờ 500 ms, sau đó tắt Bảng chỉ đường tức thì.',
            'Chọn Đèn lồng làm chỗ chạm để đợi 0,5 giây và giấu Bảng chỉ đường không fade.',
        ],
        expected: { status: 'needs_clarification' },
    },
    {
        group: 'challenge-museum-missing-recording',
        context: museum,
        prompts: [
            'Vào trang phát tệp Lời mời tham quan một lần.',
            'Mở trang lên thì chạy âm thanh Lời mời tham quan ngay.',
            'Ngay khi người đọc tới trang, phát bản thu “Lời mời tham quan”.',
        ],
        expected: { status: 'needs_clarification' },
    },
    {
        group: 'challenge-observatory-await-video',
        context: observatory,
        prompts: [
            'Bấm Nút quan sát, cho Phim nhật thực chạy hết rồi mới hiện Sơ đồ quỹ đạo.',
            'Khi bấm Nút quan sát, mở Phim nhật thực. Chờ tới đúng lúc video kết thúc thì bật Sơ đồ quỹ đạo.',
            'Chạm Nút quan sát để chạy Phim nhật thực, đến khung cuối mới hiện Sơ đồ quỹ đạo.',
        ],
        expected: { status: 'unsupported' },
    },
];

export const challengeCases: BenchmarkCase[] = scenarios.flatMap(
    ({ group, context, prompts, expected }) =>
        prompts.map((instruction, index) => ({
            id: `${group}-${index + 1}`,
            group,
            split: 'challenge',
            instruction,
            context,
            expected,
        })),
);
