import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { env } from '../../config';
import { pool } from '../../db';
import { parseCloudinaryUrl } from '../../lib/cloudinary';
import { JobError, type JobHandler } from '../../modules/jobs/jobs.types';
import { capturePrintSource } from '../../modules/print/print.source';
import { viewerLink } from '../../modules/publish/publish.link';
import {
    assertPublicationAvailable,
    readPublishSnapshot,
    snapshotHash,
} from '../../modules/publish/publish.snapshot';
import type { PublishSnapshot } from '../../modules/publish/publish.types';
import { JobResultsSchema, type ManifestGroup } from '../../schema';
import { generateBookSlug } from '../../utils';
import { assertPublishable, makeManifest } from './manifest';
import {
    compressGroup,
    decodeSingleMind,
    encodeGroup,
    MAX_OUTPUT_BYTES,
    type MindTarget,
} from './mind';
import { commitPublication, type PublishedFiles } from './repo';
import { createPublishStorage, type PublishStorage } from './storage';

const PayloadSchema = z.object({
    visibility: z.enum(['PUBLIC', 'UNLISTED']),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptWarnings: z.boolean(),
    snapshot: z
        .custom<PublishSnapshot>((value) =>
            Boolean(value && typeof value === 'object' && 'book' in value && 'pages' in value),
        )
        .optional(),
});

export function createPublishHandler(storage: PublishStorage, viewerOrigin: string): JobHandler {
    return async (ctx) => {
        if (ctx.job.ref_type !== 'BOOK' || !ctx.job.created_by)
            throw new JobError('INVALID_REFERENCE', 'Job xuất bản cần sách và tác giả.');
        const payload = PayloadSchema.safeParse(ctx.job.payload);
        if (!payload.success)
            throw new JobError(
                'PUBLISH_REQUEST_EXPIRED',
                'Yêu cầu xuất bản cũ không có snapshot. Hãy gửi lại từ API mới.',
            );
        const snapshot =
            payload.data.snapshot ??
            (await readPublishSnapshot(pool, ctx.job.created_by, ctx.job.ref_id));
        if (!snapshot || snapshotHash(snapshot) !== payload.data.snapshotHash)
            throw new JobError(
                'PUBLISH_STALE',
                'Sách đã thay đổi từ lúc bấm xuất bản. Hãy gửi yêu cầu mới.',
            );
        if (snapshot.book.id !== ctx.job.ref_id || snapshot.book.owner_id !== ctx.job.created_by)
            throw new JobError('INVALID_REFERENCE', 'Dữ liệu xuất bản không khớp sách và tác giả.');
        await assertPublicationAvailable(pool, snapshot);
        ctx.signal.throwIfAborted();
        try {
            assertPublishable(snapshot, payload.data.acceptWarnings);
            // Kiểm tra dữ liệu in trước khi upload để tránh để lại file mồ côi vì nguồn in lỗi.
            capturePrintSource(snapshot);
        } catch (error) {
            if (error instanceof JobError) throw error;
            throw new JobError(
                'INVALID_PUBLISH_DATA',
                'Scene, settings hoặc dữ liệu xuất bản không hợp lệ.',
            );
        }
        const slug = snapshot.book.slug ?? generateBookSlug(snapshot.book.title);
        const url = viewerLink(viewerOrigin, slug);
        const prefix = `bookaria/published/${snapshot.book.id}/v${snapshot.version}/${ctx.job.id}-${ctx.job.attempts}`;
        const groups: ManifestGroup[] = [],
            storedGroups: PublishedFiles['groups'] = [];
        let targets: MindTarget[] = [],
            pageIds: string[] = [],
            groupBytes = 0,
            totalInput = 0;
        const upload = (id: string, bytes: Buffer, mime: string) =>
            storage.upload(`${prefix}/${id}`, bytes, mime, ctx.signal);
        async function flush() {
            if (!targets.length) return;
            ctx.signal.throwIfAborted();
            const group = groups.length,
                bytes = encodeGroup(targets),
                id = `${prefix}/group-${group}.mind`;
            const mindUrl = await storage.upload(id, bytes, 'application/octet-stream', ctx.signal);
            await upload(`group-${group}.mind.gz`, compressGroup(bytes), 'application/gzip');
            groups.push({ group, mindUrl, pageIds: [...pageIds] });
            storedGroups.push({ group, public_id: id, page_ids: [...pageIds] });
            groupBytes += bytes.length;
            targets = [];
            pageIds = [];
        }
        const arPages = snapshot.pages.filter((p) => p.marker_mode !== 'NONE');
        await ctx.setProgress(5);
        for (const [index, page] of arPages.entries()) {
            ctx.signal.throwIfAborted();
            const publicId =
                page.marker_mode === 'CUSTOM_MARKER'
                    ? page.marker_mind_public_id
                    : snapshot.markers.find((m) => m.id === page.bookaria_marker_id)
                          ?.mind_public_id;
            if (!publicId) throw new JobError('MISSING_MIND', 'Thiếu file .mind của trang.');
            const bytes = await storage.downloadMind(publicId, ctx.signal);
            totalInput += bytes.length;
            if (totalInput > 100 * 1024 * 1024)
                throw new JobError(
                    'PUBLISH_INPUT_SIZE',
                    'Tổng .mind vượt 100 MiB cho một lần xuất bản.',
                );
            const target = decodeSingleMind(bytes);
            if (
                targets.length === 10 ||
                (targets.length > 0 && encodeGroup([...targets, target]).length > MAX_OUTPUT_BYTES)
            )
                await flush();
            targets.push(target);
            pageIds.push(page.id);
            await ctx.setProgress(5 + Math.round((65 * (index + 1)) / arPages.length));
        }
        await flush();
        const manifest = makeManifest(snapshot, groups, storage, new Date().toISOString());
        const manifestBytes = Buffer.from(JSON.stringify(manifest));
        await upload('manifest.json', manifestBytes, 'application/json');
        await ctx.setProgress(80);
        await upload(
            'qr.png',
            await QRCode.toBuffer(url, { width: 512, margin: 4, errorCorrectionLevel: 'M' }),
            'image/png',
        );
        await upload(
            'qr.svg',
            Buffer.from(
                await QRCode.toString(url, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' }),
            ),
            'image/svg+xml',
        );
        const used = new Set(snapshot.pages.flatMap((p) => [p.image_asset_id]));
        if (snapshot.book.cover_asset_id) used.add(snapshot.book.cover_asset_id);
        for (const id of Object.keys(manifest.assets)) used.add(id);
        const assetBytes = snapshot.assets
            .filter((a) => used.has(a.id))
            .reduce((sum, a) => sum + Number(a.meta.downloadBytes ?? a.size_bytes), 0);
        const files: PublishedFiles = {
            versionId: randomUUID(),
            slug,
            visibility: payload.data.visibility,
            manifestId: `${prefix}/manifest.json`,
            groups: storedGroups,
            totalBytes: assetBytes + groupBytes + manifestBytes.length,
            arCount: arPages.length,
        };
        ctx.signal.throwIfAborted();
        await ctx.setProgress(95);
        ctx.onSuccess((db) => commitPublication(db, snapshot, payload.data.snapshotHash, files));
        return JobResultsSchema.PUBLISH_BOOK.parse({ versionNo: snapshot.version, slug, url });
    };
}
export const publishBookHandler: JobHandler = async (ctx) => {
    if (!env.CLOUDINARY_URL)
        throw new JobError('STORAGE_NOT_CONFIGURED', 'Chưa cấu hình Cloudinary.', true);
    return createPublishHandler(
        createPublishStorage(parseCloudinaryUrl(env.CLOUDINARY_URL)),
        env.VIEWER_URL,
    )(ctx);
};
