import { describe, expect, it } from 'vitest';
import { createCloudinaryStorage } from '../../../lib/cloudinary';
import { capturePrintSource } from '../../../modules/print/print.source';
import type { PublishSnapshot } from '../../../modules/publish/publish.types';
import { makeManifest } from '../manifest';

const bid = '11111111-1111-4111-8111-111111111111',
    pid = '22222222-2222-4222-8222-222222222222',
    aid = '33333333-3333-4333-8333-333333333333';
const media = createCloudinaryStorage({ cloudName: 'demo', apiKey: 'test', apiSecret: 'test' });
function snapshot(): PublishSnapshot {
    return {
        book: { id: bid, title: 'Source book', page_aspect: '0.5', page_width_mm: '300' },
        version: 1,
        pages: [
            {
                id: pid,
                title: null,
                image_asset_id: aid,
                marker_mode: 'NONE',
                scene: { schemaVersion: 1, objects: [], interactions: [] },
                settings: {},
            },
        ],
        assets: [
            {
                id: aid,
                resource_type: 'image',
                original_public_id: 'bookaria/original',
                optimized_public_id: null,
                format: 'png',
                thumbnail_url: null,
                meta: { width: 1200, height: 600 },
                size_bytes: '100',
                type: 'IMAGE',
            },
        ],
        markers: [],
    } as unknown as PublishSnapshot;
}
describe('one-source publication and frozen print geometry', () => {
    it('publishes the same deterministic JPEG layout used for marker compilation, without another asset', () => {
        const manifest = makeManifest(
            snapshot(),
            [],
            { url: media.deliveryUrl },
            '2026-10-29T00:00:00Z',
        );
        expect(manifest.pages[0]?.imageUrl).toBe(
            'https://res.cloudinary.com/demo/image/upload/c_pad,w_1600,h_800,g_center,b_white,f_jpg,q_94/v1/bookaria/original.jpg',
        );
        expect(manifest.pages[0]?.thumbnailUrl).toContain('c_pad,w_320,h_160');
        expect(Object.keys(manifest.assets)).toHaveLength(0);
    });
    it('freezes source identity plus aspect so later draft edits cannot change PDF geometry', () => {
        const live = snapshot(),
            frozen = capturePrintSource(live);
        live.book.page_aspect = String(14142 / 10000);
        expect(frozen.pages[0]?.image).toEqual({
            publicId: 'bookaria/original',
            format: 'png',
            pageAspect: 0.5,
        });
        expect(frozen.widthMm).toBe(300);
        expect(frozen.heightMm).toBe(150);
    });
});
