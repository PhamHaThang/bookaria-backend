import type { Queryable } from '../../db';
import type { Manifest } from '../../schema';
import { JobError } from '../jobs/jobs.types';
import { snapshotHash } from '../publish/publish.snapshot';
import { type PreviewRequest, readPreviewSnapshot } from './preview.snapshot';
import type { PreviewGroup, PreviewRow } from './preview.types';

export const previewRepository = {
    /**
     * Tìm kiếm Job tạo Preview đang mở cho sách.
     */
    async findOpenPreviewJob(db: Queryable, bookId: string) {
        const { rows } = await db.query<{ id: string }>(
            `SELECT id FROM jobs WHERE type='BUILD_PREVIEW' AND ref_type='BOOK' AND ref_id=$1 AND status IN ('QUEUED', 'RUNNING')`,
            [bookId],
        );
        return rows[0]?.id;
    },
    /**
     * Tạo một Job tạo Preview mới cho sách.
     */
    async insertPreviewJob(
        db: Queryable,
        ownerId: string,
        bookId: string,
        request: PreviewRequest,
        hash: string,
    ) {
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO jobs(type,ref_type,ref_id,created_by,payload)
            VALUES ('BUILD_PREVIEW','BOOK',$1,$2,$3::jsonb) RETURNING id`,
            [bookId, ownerId, JSON.stringify({ request, snapshotHash: hash })],
        );
        return rows[0]?.id as string;
    },
    /**
     * Kiểm tra bản nháp có bị thay đổi không, rồi lưu Preview.
     */
    async commit(
        db: Queryable,
        input: {
            ownerId: string;
            bookId: string;
            request: PreviewRequest;
            hash: string;
            token: string;
            manifest: Manifest;
            groups: PreviewGroup[];
        },
    ) {
        const current = await readPreviewSnapshot(
            db,
            input.ownerId,
            input.bookId,
            input.request,
            true,
        );
        if (snapshotHash(current) !== input.hash)
            throw new JobError('PREVIEW_STALE', 'Bản nháp đã đổi; hãy tạo preview mới.');
        await db.query(
            `INSERT INTO preview_links(book_id,token,manifest,mind_groups,created_by,expires_at)
            VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,clock_timestamp()+interval '24 hours')`,
            [
                input.bookId,
                input.token,
                JSON.stringify(input.manifest),
                JSON.stringify(input.groups),
                input.ownerId,
            ],
        );
    },
    /**
     * Kiểm tra một Preview Link còn hợp lệ để truy cập hay không.
     */
    async available(db: Queryable, token: string): Promise<PreviewRow | undefined> {
        const { rows } = await db.query<PreviewRow>(
            `SELECT p.id,p.manifest,COALESCE(p.mind_groups,'[]'::jsonb) AS mind_groups,p.expires_at FROM preview_links p
            JOIN books b ON b.id=p.book_id JOIN users u ON u.id=b.owner_id
            WHERE p.token=$1 AND p.expires_at>clock_timestamp() AND b.deleted_at IS NULL
            AND b.taken_down_at IS NULL AND u.status='ACTIVE' AND p.created_by=b.owner_id`,
            [token],
        );
        return rows[0];
    },
};
