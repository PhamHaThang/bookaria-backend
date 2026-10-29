import type { Queryable } from '../../db';
import { JobError, type JobRow } from '../../modules/jobs/jobs.types';
import { type MarkerReport, MarkerReportSchema } from '../../schema';
import type { MarkerSnapshot, MarkerSource, PeerComparison } from './types';
import { SCORE_POLICY } from './vision';

export const scoreRepository = {
    /**
     * Lấy thông tin các trang marker Custom trong sách
     */
    async getMarkerSources(db: Queryable, bookId: string, lock = false): Promise<MarkerSource[]> {
        const { rows } = await db.query<MarkerSource>(
            `SELECT p.id, p.book_id, p.image_asset_id, p.marker_mind_public_id, b.page_aspect::float AS page_aspect,
                a.original_public_id, a.resource_type, a.format, a.size_bytes,
                a.status AS image_status, (a.deleted_at IS NOT NULL) AS image_deleted
            FROM pages p JOIN books b ON b.id=p.book_id JOIN assets a ON a.id = p.image_asset_id
            WHERE p.book_id = $1 AND p.marker_mode = 'CUSTOM_MARKER'
            ORDER BY p.id ${lock ? 'FOR UPDATE OF p FOR SHARE OF a' : ''}`,
            [bookId],
        );
        return rows;
    },
    /**
     * Lấy thông tin snapshot ban đầu của một marker Custom
     */
    async getMarkerSnapshot(db: Queryable, job: JobRow): Promise<MarkerSnapshot> {
        // Kiểm tra chủ sở hữu Job
        if (!job.created_by) throw new JobError('INVALID_OWNER', 'Tác vụ cần chủ sở hữu sách.');

        // Kiểm tra sách và lấy thông tin các trang marker Custom trong sách
        const book = await db.query<{ id: string }>(
            `SELECT b.id FROM books b JOIN pages p ON p.book_id = b.id
            WHERE p.id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL`,
            [job.ref_id, job.created_by],
        );
        const bookId = book.rows[0]?.id;
        if (!bookId)
            throw new JobError('PAGE_NOT_FOUND', 'Trang không tồn tại hoặc không thuộc tác giả.');

        const pages = await this.getMarkerSources(db, bookId);
        if (!pages.some((p) => p.id === job.ref_id)) {
            throw new JobError('NOT_CUSTOM_MARKER', 'Trang không còn dùng marker Custom.');
        }
        return { bookId, ownerId: job.created_by, targetId: job.ref_id, pages };
    },

    /**
     * Lưu kết quả chấm điểm marker Custom, đồng thời cập nhật các trang peer nếu cần
     */
    async saveResult(
        db: Queryable,
        snapshot: MarkerSnapshot,
        score: number,
        report: MarkerReport,
        comparisons: PeerComparison[],
    ): Promise<void> {
        // Khóa bản ghi sách
        const book = await db.query(
            'SELECT id FROM books WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',
            [snapshot.bookId, snapshot.ownerId],
        );
        if (book.rowCount !== 1)
            throw new JobError('BOOK_CHANGED', 'Sách đã bị xóa hoặc đổi chủ sở hữu.');

        // Đọc lại trạng thái hiện tại của các trang marker Custom trong sách, so sánh với snapshot ban đầu
        const current = await this.getMarkerSources(db, snapshot.bookId, true);
        const originalTarget = snapshot.pages.find((p) => p.id === snapshot.targetId);
        const currentTarget = current.find((p) => p.id === snapshot.targetId);
        if (!currentTarget || JSON.stringify(originalTarget) !== JSON.stringify(currentTarget)) {
            throw new JobError(
                'STALE_MARKER',
                'Ảnh hoặc chế độ marker đã thay đổi; bỏ kết quả cũ.',
            );
        }
        if (JSON.stringify(snapshot.pages) !== JSON.stringify(current)) {
            throw new JobError(
                'MARKER_SET_CHANGED',
                'Các trang Custom trong sách đã thay đổi; cần so khớp lại.',
                true,
            );
        }
        // Lưu kết quả chấm điểm
        const checked = MarkerReportSchema.parse(report);
        await db.query(
            'UPDATE pages SET marker_score=$2, marker_features=$3, marker_report=$4::jsonb WHERE id=$1',
            [snapshot.targetId, score, checked.features, JSON.stringify(checked)],
        );
        const peers = await db.query<{ id: string; marker_report: unknown }>(
            "SELECT id, marker_report FROM pages WHERE book_id=$1 AND marker_mode='CUSTOM_MARKER' AND id<>$2",
            [snapshot.bookId, snapshot.targetId],
        );
        // Cập nhật báo cáo marker cho các trang peer
        const currentIds = new Set(current.map((p) => p.id));
        for (const peer of peers.rows) {
            const comparison = comparisons.find((p) => p.pageId === peer.id);
            if (!comparison) throw new Error('Missing peer comparison');
            const parsed = MarkerReportSchema.safeParse(peer.marker_report);
            const base: MarkerReport = parsed.success
                ? parsed.data
                : {
                      features: comparison.features,
                      coverage: comparison.coverage,
                      heatmapUrl: null,
                      similarPages: [],
                      hints: comparison.hints,
                  };
            const links = base.similarPages.filter(
                (p) => p.pageId !== snapshot.targetId && currentIds.has(p.pageId),
            );
            if (comparison.similarity >= SCORE_POLICY.similarThreshold) {
                links.push({ pageId: snapshot.targetId, similarity: comparison.similarity });
            }
            const updated = MarkerReportSchema.parse({
                ...base,
                similarPages: links.sort((a, b) => a.pageId.localeCompare(b.pageId)),
            });
            if (JSON.stringify(updated) !== JSON.stringify(peer.marker_report)) {
                await db.query('UPDATE pages SET marker_report=$2::jsonb WHERE id=$1', [
                    peer.id,
                    JSON.stringify(updated),
                ]);
            }
        }
    },
};
