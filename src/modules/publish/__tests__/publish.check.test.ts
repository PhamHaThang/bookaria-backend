import { describe, expect, it } from 'vitest';
import { type PublishCheck, PublishCheckSchema } from '../../../schema';
import { buildPublishCheck, LARGE_DOWNLOAD_BYTES } from '../publish.service';
import type { CheckAsset, CheckInput, CheckPage } from '../publish.types';

const MB = 1024 * 1024;
const emptyScene = { schemaVersion: 1, objects: [], interactions: [] };
const asset = (id: string, changes: Partial<CheckAsset> = {}): CheckAsset => ({
    id,
    status: 'READY',
    sizeBytes: 1000,
    ...changes,
});
const page = (id: string, changes: Partial<CheckPage> = {}): CheckPage => ({
    id,
    orderIndex: 0,
    markerMode: 'BOOKARIA_MARKER',
    markerScore: null,
    markerReport: null,
    scene: emptyScene,
    image: asset(`image-${id}`),
    assets: [],
    ...changes,
});
const input = (pages: CheckPage[], changes: Partial<CheckInput> = {}): CheckInput => ({
    pageAspect: Math.SQRT2,
    emailVerified: true,
    takenDown: false,
    pages,
    ...changes,
});
const codes = (items: Pick<PublishCheck['errors'][number], 'code'>[]) =>
    items.map((item) => item.code);

describe('buildPublishCheck', () => {
    it('sách hợp lệ có đúng tóm tắt và hợp đồng response', () => {
        const result = buildPublishCheck(
            input([page('a'), page('b', { orderIndex: 1, markerMode: 'NONE' })]),
        );
        expect(PublishCheckSchema.parse(result)).toEqual({
            canPublish: true,
            summary: { pageCount: 2, arPageCount: 1, downloadBytes: 0 },
            errors: [],
            warnings: [],
        });
    });

    it('email chưa xác nhận và sách bị gỡ đều chặn; sách không có AR cũng bị chặn', () => {
        const blocked = buildPublishCheck(
            input([page('a')], { emailVerified: false, takenDown: true }),
        );
        expect(codes(blocked.errors)).toEqual(['EMAIL_NOT_VERIFIED', 'BOOK_TAKEN_DOWN']);
        expect(blocked.canPublish).toBe(false);
        expect(codes(buildPublishCheck(input([])).errors)).toEqual(['NO_AR_PAGE']);
        expect(codes(buildPublishCheck(input([page('a', { markerMode: 'NONE' })])).errors)).toEqual(
            ['NO_AR_PAGE'],
        );
    });

    it('ảnh mất và tài nguyên chưa sẵn sàng được báo ở đúng trang, không lặp cùng tệp', () => {
        const result = buildPublishCheck(
            input([
                page('a', { image: null }),
                page('b', {
                    orderIndex: 1,
                    image: asset('same', { status: 'PROCESSING' }),
                    assets: [
                        asset('same', { status: 'PROCESSING' }),
                        asset('bad', { status: 'FAILED' }),
                    ],
                }),
            ]),
        );
        expect(result.errors).toMatchObject([
            { code: 'PAGE_NO_IMAGE', pageId: 'a' },
            { code: 'ASSET_NOT_READY', pageId: 'b', assetId: 'same' },
            { code: 'ASSET_FAILED', pageId: 'b', assetId: 'bad' },
        ]);
    });

    it('marker riêng cần ít nhất 3 sao; marker Bookaria không cần điểm', () => {
        const result = buildPublishCheck(
            input([
                page('a', { markerMode: 'CUSTOM_MARKER', markerScore: null }),
                page('b', { orderIndex: 1, markerMode: 'CUSTOM_MARKER', markerScore: 2 }),
                page('c', { orderIndex: 2, markerMode: 'CUSTOM_MARKER', markerScore: 3 }),
                page('d', { orderIndex: 3 }),
            ]),
        );
        expect(result.errors).toMatchObject([
            { code: 'PAGE_NOT_SCORED', pageId: 'a' },
            { code: 'PAGE_LOW_SCORE', pageId: 'b' },
        ]);
    });

    it('quy tắc trỏ đến đối tượng đã xoá mang mã trang và quy tắc', () => {
        const scene = {
            schemaVersion: 1,
            objects: [{ id: 'text1', type: 'text', text: 'Xin chào', transform: {} }],
            interactions: [
                {
                    id: 'rule1',
                    trigger: { type: 'onTap', objectId: 'gone' },
                    actions: [{ type: 'setVisible', objectId: 'text1', value: true }],
                },
            ],
        };
        const result = buildPublishCheck(input([page('p', { scene })]));
        expect(result.errors).toMatchObject([
            { code: 'INTERACTION_INVALID', pageId: 'p', interactionId: 'rule1' },
        ]);
    });

    it('scene không đọc được trả lỗi thay vì làm hỏng kiểm tra', () => {
        const result = buildPublishCheck(input([page('a', { scene: { schemaVersion: 9 } })]));
        expect(result.errors).toMatchObject([{ code: 'INTERACTION_INVALID', pageId: 'a' }]);
    });

    it('cảnh báo của scene mang đúng trang và đối tượng, nhưng không chặn xuất bản', () => {
        const objects = Array.from({ length: 21 }, (_, i) => ({
            id: `text${i}`,
            type: 'text',
            text: 'x',
            transform: {},
        }));
        const scene = {
            schemaVersion: 1,
            objects: [
                ...objects,
                { id: 'far', type: 'text', text: 'x', transform: { position: [3, 0, 0] } },
            ],
            interactions: [],
        };
        const result = buildPublishCheck(
            input([page('a', { scene, assets: [asset('model', { sizeBytes: 16 * MB })] })]),
        );
        expect(result.canPublish).toBe(true);
        expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
            'OBJECT_OFF_PAGE',
            'PAGE_HEAVY',
            'TOO_MANY_OBJECTS',
        ]);
        expect(result.warnings.find((warning) => warning.code === 'OBJECT_OFF_PAGE')).toMatchObject(
            {
                pageId: 'a',
                objectId: 'far',
            },
        );
    });

    it('cảnh báo lệch trang dùng tỉ lệ trang của sách', () => {
        const scene = {
            schemaVersion: 1,
            objects: [
                { id: 'text', type: 'text', text: 'x', transform: { position: [0, 0.8, 0] } },
            ],
            interactions: [],
        };
        expect(buildPublishCheck(input([page('a', { scene })])).warnings).toEqual([]);
        expect(
            buildPublishCheck(input([page('a', { scene })], { pageAspect: 1 })).warnings,
        ).toMatchObject([{ code: 'OBJECT_OFF_PAGE', pageId: 'a', objectId: 'text' }]);
    });

    it('cặp marker giống nhau được báo một lần và bỏ qua trang đã xoá', () => {
        const a = '3d1b6a52-0000-4000-8000-000000000001';
        const b = '3d1b6a52-0000-4000-8000-000000000002';
        const gone = '3d1b6a52-0000-4000-8000-000000000003';
        const custom = (id: string, orderIndex: number, otherPageId: string) =>
            page(id, {
                orderIndex,
                markerMode: 'CUSTOM_MARKER',
                markerScore: 4,
                markerReport: {
                    features: 100,
                    coverage: 0.8,
                    heatmapUrl: null,
                    hints: [],
                    similarPages: [{ pageId: otherPageId, similarity: 0.9 }],
                },
            });
        const result = buildPublishCheck(input([custom(a, 0, b), custom(b, 1, a)]));
        expect(result.warnings).toMatchObject([
            { code: 'PAGE_SIMILAR', pageId: a, otherPageId: b },
        ]);
        expect(buildPublishCheck(input([custom(a, 0, gone)])).warnings).toEqual([]);
    });

    it('tệp dùng chung chỉ tính một lần; đúng 50 MB không cảnh báo, vượt thì có', () => {
        const shared = asset('shared', { sizeBytes: 30 * MB });
        const sharedResult = buildPublishCheck(
            input([
                page('a', { assets: [shared] }),
                page('b', { orderIndex: 1, assets: [shared] }),
            ]),
        );
        expect(sharedResult.summary.downloadBytes).toBe(30 * MB);
        expect(sharedResult.warnings.some((warning) => warning.code === 'LARGE_DOWNLOAD')).toBe(
            false,
        );

        const atLimit = buildPublishCheck(
            input([page('a', { assets: [asset('x', { sizeBytes: LARGE_DOWNLOAD_BYTES })] })]),
        );
        expect(atLimit.warnings.some((warning) => warning.code === 'LARGE_DOWNLOAD')).toBe(false);

        const overLimit = buildPublishCheck(
            input([
                page('a', {
                    assets: [
                        asset('x', { sizeBytes: LARGE_DOWNLOAD_BYTES }),
                        asset('y', { sizeBytes: 1 }),
                    ],
                }),
            ]),
        );
        expect(overLimit.warnings.some((warning) => warning.code === 'LARGE_DOWNLOAD')).toBe(true);
    });

    it('ảnh trang không tính vào dung lượng tải xuống', () => {
        const result = buildPublishCheck(
            input([page('a', { image: asset('large-image', { sizeBytes: 90 * MB }) })]),
        );
        expect(result.summary.downloadBytes).toBe(0);
    });
});
