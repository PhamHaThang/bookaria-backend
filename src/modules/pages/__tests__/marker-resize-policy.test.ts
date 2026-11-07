import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '../../../db';
import { resizePageImages } from '../page-resize';
import { pagesRepository } from '../pages.repository';

const id = '11111111-1111-4111-8111-111111111111';
function fixture() {
    const page = {
        id,
        image_asset_id: id,
        marker_mode: 'CUSTOM_MARKER' as const,
        marker_mind_public_id: 'bookaria/author/old.mind',
    };
    vi.spyOn(pagesRepository, 'hasOpenBookJob').mockResolvedValue(false);
    vi.spyOn(pagesRepository, 'getPages').mockResolvedValue([page] as Awaited<
        ReturnType<typeof pagesRepository.getPages>
    >);
    vi.spyOn(pagesRepository, 'hasOpenScoreJob').mockResolvedValue(false);
    const set = vi.spyOn(pagesRepository, 'setCustomMarkerFile').mockResolvedValue(undefined);
    const job = vi.spyOn(pagesRepository, 'insertScoreJob').mockResolvedValue(id);
    const entry = {
        pageId: id,
        expectedImageAssetId: id,
        expectedMarkerMode: 'CUSTOM_MARKER' as const,
        markerMindPublicId: page.marker_mind_public_id,
    };
    return { db: {} as Queryable, entry, set, job };
}
afterEach(() => vi.restoreAllMocks());
describe('new geometry requires a new marker compilation', () => {
    it('rejects the old marker file before mutating the page or queuing analysis', async () => {
        const f = fixture();
        await expect(resizePageImages(f.db, id, id, [f.entry])).rejects.toThrow(
            /Cần biên dịch tệp marker mới/,
        );
        expect(f.set).not.toHaveBeenCalled();
        expect(f.job).not.toHaveBeenCalled();
    });
    it('queues analysis for the new marker file', async () => {
        const f = fixture();
        await resizePageImages(f.db, id, id, [
            { ...f.entry, markerMindPublicId: 'bookaria/author/new.mind' },
        ]);
        expect(f.set).toHaveBeenCalledWith(f.db, id, 'bookaria/author/new.mind');
        expect(f.job).toHaveBeenCalledTimes(1);
    });
    it('preserves safe retry of an already applied identical replacement batch', async () => {
        const f = fixture();
        await resizePageImages(f.db, id, id, [f.entry], true);
        expect(f.set).not.toHaveBeenCalled();
        expect(f.job).not.toHaveBeenCalled();
    });
});
