import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config';
import { pool } from '../../db';
import { parseCloudinaryUrl } from '../../lib/cloudinary';
import { JobError, type JobHandler } from '../../modules/jobs/jobs.types';
import { previewRepository } from '../../modules/previews/preview.repository';
import { PreviewPayloadSchema, readPreviewSnapshot } from '../../modules/previews/preview.snapshot';
import type { PreviewGroup } from '../../modules/previews/preview.types';
import { publicOrigin } from '../../modules/publish/publish.link';
import { snapshotHash } from '../../modules/publish/publish.snapshot';
import { JobResultsSchema, type ManifestGroup } from '../../schema';
import { makeManifest } from '../publish/manifest';
import { decodeSingleMind, encodeGroup, MAX_OUTPUT_BYTES, type MindTarget } from '../publish/mind';
import { createPublishStorage, type PublishStorage } from '../publish/storage';

export function createBuildPreviewHandler(
    storage: PublishStorage,
    viewerOrigin: string,
    apiOrigin: string,
): JobHandler {
    return async (ctx) => {
        if (ctx.job.ref_type !== 'BOOK' || !ctx.job.created_by)
            throw new JobError('INVALID_REFERENCE', 'Preview cần sách và tác giả.');
        const payload = PreviewPayloadSchema.safeParse(ctx.job.payload);
        if (!payload.success)
            throw new JobError(
                'PREVIEW_REQUEST_EXPIRED',
                'Yêu cầu preview cũ không hợp lệ; hãy gửi lại.',
            );
        const { request, snapshotHash: hash } = payload.data;
        const snapshot = await readPreviewSnapshot(
            pool,
            ctx.job.created_by,
            ctx.job.ref_id,
            request,
        );
        if (snapshotHash(snapshot) !== hash)
            throw new JobError('PREVIEW_STALE', 'Bản nháp đã đổi; hãy tạo preview mới.');
        ctx.signal.throwIfAborted();
        const token = randomBytes(24).toString('base64url');
        const url = new URL(`/preview/${token}`, publicOrigin(viewerOrigin)).toString();
        const api = publicOrigin(apiOrigin);
        const prefix = `bookaria/previews/${snapshot.book.id}/${ctx.job.id}-${ctx.job.attempts}`;
        const groups: ManifestGroup[] = [],
            stored: PreviewGroup[] = [];
        let targets: MindTarget[] = [],
            pageIds: string[] = [],
            totalInput = 0;
        async function flush() {
            if (!targets.length) return;
            ctx.signal.throwIfAborted();
            const group = groups.length,
                bytes = encodeGroup(targets),
                publicId = `${prefix}/group-${group}.mind`;
            await storage.upload(publicId, bytes, 'application/octet-stream', ctx.signal);
            // Never put an unguarded CDN group URL in the preview manifest.
            groups.push({
                group,
                mindUrl: new URL(
                    `/api/v1/public/previews/${token}/groups/${group}`,
                    api,
                ).toString(),
                pageIds: [...pageIds],
            });
            stored.push({
                group,
                publicId,
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            });
            targets = [];
            pageIds = [];
        }
        const ar = snapshot.pages.filter((p) => p.marker_mode !== 'NONE');
        await ctx.setProgress(5);
        for (const [index, page] of ar.entries()) {
            ctx.signal.throwIfAborted();
            const id =
                page.marker_mode === 'CUSTOM_MARKER'
                    ? page.marker_mind_public_id
                    : snapshot.markers.find((m) => m.id === page.bookaria_marker_id)
                          ?.mind_public_id;
            if (!id) throw new JobError('PREVIEW_INVALID_MIND', 'Thiếu .mind của trang.');
            const bytes = await storage.downloadMind(id, ctx.signal);
            totalInput += bytes.length;
            if (totalInput > 100 * 1024 * 1024)
                throw new JobError('PREVIEW_INPUT_SIZE', 'Tổng .mind vượt 100 MiB.');
            const target = decodeSingleMind(bytes);
            if (
                targets.length === 10 ||
                (targets.length > 0 && encodeGroup([...targets, target]).length > MAX_OUTPUT_BYTES)
            )
                await flush();
            targets.push(target);
            pageIds.push(page.id);
            await ctx.setProgress(5 + Math.round((80 * (index + 1)) / ar.length));
        }
        await flush();
        const manifest = makeManifest(snapshot, groups, storage, new Date().toISOString());
        if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_OUTPUT_BYTES)
            throw new JobError('PREVIEW_MANIFEST_SIZE', 'Manifest preview quá lớn.');
        ctx.signal.throwIfAborted();
        await ctx.setProgress(95);
        ctx.onSuccess((db) =>
            previewRepository.commit(db, {
                ownerId: snapshot.book.owner_id,
                bookId: snapshot.book.id,
                request,
                hash,
                token,
                manifest,
                groups: stored,
            }),
        );
        return JobResultsSchema.BUILD_PREVIEW.parse({ token, url });
    };
}
export const buildPreviewHandler: JobHandler = async (ctx) => {
    if (!env.CLOUDINARY_URL)
        throw new JobError('STORAGE_NOT_CONFIGURED', 'Chưa cấu hình Cloudinary.', true);
    return createBuildPreviewHandler(
        createPublishStorage(parseCloudinaryUrl(env.CLOUDINARY_URL)),
        env.VIEWER_URL,
        env.PUBLIC_API_URL,
    )(ctx);
};
