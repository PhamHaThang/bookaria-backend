import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createR2Storage, derivativeKey } from '../../../lib/storage';
import { capturePrintSource } from '../../../modules/print/print.source';
import { publicationContentHash } from '../../../modules/publish/publish.snapshot';
import type { PublishSnapshot } from '../../../modules/publish/publish.types';
import { account, fakeR2 } from '../../../test/r2';
import { makeManifest } from '../manifest';

const bid = '11111111-1111-4111-8111-111111111111',
    pid = '22222222-2222-4222-8222-222222222222',
    aid = '33333333-3333-4333-8333-333333333333';
async function storage() {
    const fake = fakeR2();
    fake.files.set('bookaria/original', {
        bytes: await sharp({ create: { width: 1200, height: 600, channels: 3, background: 'red' } })
            .png()
            .toBuffer(),
        type: 'image/png',
        format: 'png',
    });
    const media = createR2Storage(account, fake.network);
    return { fake, media, storage: { url: media.deliveryUrl, prepareImage: media.prepareImage } };
}

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
    it('freezes memory defaults in the manifest and detects changes before republishing', async () => {
        const prepared = await storage();
        const source = snapshot(),
            previous = publicationContentHash(source);
        source.book.workflow_variables = [
            { key: 'score', name: 'Điểm khám phá', type: 'number', initialValue: 10 },
        ];
        const manifest = await makeManifest(source, [], prepared.storage, '2026-11-05T00:00:00Z');
        expect(manifest.workflowVariables).toEqual(source.book.workflow_variables);
        expect(publicationContentHash(source)).not.toBe(previous);
    });
    it('publishes the same deterministic JPEG layout used for marker compilation, without another asset', async () => {
        const prepared = await storage();
        const manifest = await makeManifest(
            snapshot(),
            [],
            prepared.storage,
            '2026-10-29T00:00:00Z',
        );
        const pageUrl = new URL(manifest.pages[0]?.imageUrl ?? '');
        expect(pageUrl.href).toBe(
            `${account.publicUrl}/${derivativeKey('bookaria/original', 'page-1600-800')}`,
        );
        expect(manifest.pages[0]?.thumbnailUrl).toBe(
            `${account.publicUrl}/${derivativeKey('bookaria/original', 'page-320-160')}`,
        );
        const bytes = prepared.fake.files.get(
            derivativeKey('bookaria/original', 'page-1600-800'),
        )?.bytes;
        expect(await sharp(bytes).metadata()).toMatchObject({
            width: 1600,
            height: 800,
            format: 'jpeg',
        });
        expect(prepared.fake.files.has(derivativeKey('bookaria/original', 'page-320-160'))).toBe(
            true,
        );
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
