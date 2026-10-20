import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../../config';
import { pool } from '../../db';
import { parseCloudinaryUrl } from '../../lib/cloudinary';
import { JobError, type JobHandler } from '../../modules/jobs/jobs.types';
import {
    PrintPayloadSchema,
    printRepository,
    readPrintVersion,
} from '../../modules/print/print.repository';
import { viewerLink } from '../../modules/publish/publish.link';
import { JobResultsSchema } from '../../schema';
import { renderPrintPdf } from './render';
import { createPrintStorage, type PrintStorage } from './storage';

export function createExportPdfHandler(
    storage: PrintStorage,
    viewerOrigin: string,
    fontBytes: Uint8Array,
): JobHandler {
    return async (ctx) => {
        if (ctx.job.ref_type !== 'BOOK' || !ctx.job.created_by)
            throw new JobError('INVALID_REFERENCE', 'Job PDF cần sách và tác giả.');
        const parsed = PrintPayloadSchema.safeParse(ctx.job.payload);
        if (!parsed.success)
            throw new JobError(
                'PRINT_REQUEST_EXPIRED',
                'Yêu cầu PDF cũ không có phiên bản; gửi lại.',
            );
        const payload = parsed.data,
            owner = ctx.job.created_by;
        const version = await readPrintVersion(pool, owner, ctx.job.ref_id, payload.versionId);
        const bytes = await renderPrintPdf({
            source: version.source,
            request: payload.request,
            versionNo: version.version_no,
            url: viewerLink(viewerOrigin, version.slug),
            fontBytes,
            signal: ctx.signal,
            download: storage.download,
            progress: ctx.setProgress,
        });
        const publicId = `bookaria/exports/${ctx.job.ref_id}/${version.id}/${ctx.job.id}-${ctx.job.attempts}/${payload.request.kind.toLowerCase()}.pdf`;
        ctx.signal.throwIfAborted();
        const url = await storage.upload(publicId, bytes, 'application/pdf', ctx.signal);
        await ctx.setProgress(95);
        ctx.signal.throwIfAborted();
        ctx.onSuccess((db) => printRepository.commit(db, owner, ctx.job.ref_id, payload, publicId));
        return JobResultsSchema.EXPORT_PDF.parse({ url, kind: payload.request.kind });
    };
}
export const exportPdfHandler: JobHandler = async (ctx) => {
    if (!env.CLOUDINARY_URL)
        throw new JobError('STORAGE_NOT_CONFIGURED', 'Chưa cấu hình Cloudinary.', true);
    const font = await readFile(resolve('assets/fonts/NotoSans-Regular.ttf'));
    return createExportPdfHandler(
        createPrintStorage(parseCloudinaryUrl(env.CLOUDINARY_URL)),
        env.VIEWER_URL,
        font,
    )(ctx);
};
