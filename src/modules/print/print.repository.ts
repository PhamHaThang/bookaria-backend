import { z } from 'zod';
import type { Queryable } from '../../db';
import { IdSchema, PrintPdfBodySchema } from '../../schema';
import { JobError } from '../jobs/jobs.types';
import { type PrintSource, PrintSourceSchema } from './print.source';

export const PrintPayloadSchema = z.object({ versionId: IdSchema, request: PrintPdfBodySchema });
export type PrintPayload = z.infer<typeof PrintPayloadSchema>;
export interface PrintVersion {
    id: string;
    version_no: number;
    slug: string;
    source: PrintSource;
}
export async function readPrintVersion(
    db: Queryable,
    ownerId: string,
    bookId: string,
    expectedVersion?: string,
    lock = false,
): Promise<PrintVersion> {
    if (lock) {
        await db.query('SELECT id FROM books WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
            bookId,
            ownerId,
        ]);
        await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [ownerId]);
    }
    const row = (
        await db.query<{ id: string; version_no: number; slug: string; print_source: unknown }>(
            `
        SELECT v.id,v.version_no,b.slug,v.print_source FROM books b JOIN users u ON u.id=b.owner_id
        JOIN book_versions v ON v.id=b.current_version_id
        WHERE b.id=$1 AND b.owner_id=$2 AND b.deleted_at IS NULL AND b.taken_down_at IS NULL
        AND b.visibility<>'PRIVATE' AND u.status='ACTIVE'`,
            [bookId, ownerId],
        )
    ).rows[0];
    if (!row) throw new JobError('PRINT_NOT_FOUND', 'Cần một bản xuất bản đang khả dụng.');
    if (expectedVersion && row.id !== expectedVersion)
        throw new JobError('PRINT_STALE', 'Phiên bản hiện hành đã đổi; hãy xuất PDF lại.');
    if (!row.print_source)
        throw new JobError(
            'PRINT_SOURCE_MISSING',
            'Bản cũ chưa lưu dữ liệu in; hãy xuất bản lại sau khi áp dụng WK-07.',
        );
    return {
        id: row.id,
        version_no: row.version_no,
        slug: row.slug,
        source: PrintSourceSchema.parse(row.print_source),
    };
}
export const printRepository = {
    async enqueue(db: Queryable, ownerId: string, bookId: string, payload: PrintPayload) {
        const open = (
            await db.query<{ id: string }>(
                "SELECT id FROM jobs WHERE type='EXPORT_PDF' AND ref_type='BOOK' AND ref_id=$1 AND status IN ('QUEUED','RUNNING')",
                [bookId],
            )
        ).rows[0];
        if (open) return { jobId: open.id, conflict: true };
        const row = (
            await db.query<{ id: string }>(
                `INSERT INTO jobs(type,ref_type,ref_id,created_by,payload)
            VALUES ('EXPORT_PDF','BOOK',$1,$2,$3::jsonb) RETURNING id`,
                [bookId, ownerId, JSON.stringify(payload)],
            )
        ).rows[0];
        return { jobId: row?.id as string, conflict: false };
    },
    async commit(
        db: Queryable,
        ownerId: string,
        bookId: string,
        payload: PrintPayload,
        publicId: string,
    ) {
        await readPrintVersion(db, ownerId, bookId, payload.versionId, true);
        // The existing immutable-version trigger permits this first assignment only.
        // Later PRINT variants remain available via their job results; never overwrite the first PDF.
        if (payload.request.kind === 'PRINT')
            await db.query(
                'UPDATE book_versions SET print_pdf_public_id=$2 WHERE id=$1 AND print_pdf_public_id IS NULL',
                [payload.versionId, publicId],
            );
    },
};
