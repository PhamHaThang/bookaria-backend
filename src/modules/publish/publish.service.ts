import { pool, type Queryable, withTransaction } from '../../db';
import {
    BookSummarySchema,
    ERROR_MESSAGES,
    findSceneReferenceIssues,
    getSceneWarnings,
    MARKER_RULES,
    MarkerReportSchema,
    MB,
    type PublishBody,
    type PublishCheck,
    PublishCheckSchema,
    type PublishError,
    type PublishWarning,
    SceneSchema,
    VersionSchema,
} from '../../schema';
import { AppError, fieldError } from '../../utils';
import { booksRepository } from '../books/books.repository';
import { toSummary } from '../books/books.service';
import { publishRepository } from './publish.repository';
import type { CheckAsset, CheckInput, PublishableBook } from './publish.types';

export const LARGE_DOWNLOAD_BYTES = 50 * MB;

export const publishService = {
    async checkBookForPublishing(db: Queryable, book: PublishableBook): Promise<PublishCheck> {
        const [pages, assets] = await Promise.all([
            publishRepository.getPagesOfBookForChecking(db, book.id),
            publishRepository.getAssetsOfBookForChecking(db, book.id),
        ]);
        return buildPublishCheck({
            pageAspect: Number(book.page_aspect),
            emailVerified: book.email_verified,
            takenDown: book.taken_down,
            pages: pages.map((p) => ({
                id: p.id,
                orderIndex: p.order_index,
                markerMode: p.marker_mode,
                markerScore: p.marker_score,
                markerReport: p.marker_report,
                scene: p.scene,
                image:
                    p.image_id && p.image_status
                        ? {
                              id: p.image_id,
                              status: p.image_status,
                              sizeBytes: Number(p.image_bytes),
                          }
                        : null,
                assets: assets
                    .filter((a) => a.page_id === p.id)
                    .map((a) => ({ id: a.id, status: a.status, sizeBytes: Number(a.size_bytes) })),
            })),
        });
    },
    // Kiểm tra xem sách có thể xuất bản hay không
    async publishCheck(userId: string, bookId: string) {
        const book = await publishRepository.findBookForPublishing(pool, userId, bookId);
        if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
        return PublishCheckSchema.parse(await this.checkBookForPublishing(pool, book));
    },
    // Thực hiện xuất bản sách, tạo job xuất bản và trả về jobId
    async publishBook(userId: string, bookId: string, body: PublishBody) {
        const visibility = body.visibility;
        if (visibility === 'PRIVATE') {
            throw fieldError('visibility', 'Không thể xuất bản sách ở chế độ riêng tư');
        }
        return withTransaction(async (db) => {
            const book = await publishRepository.findBookForPublishing(db, userId, bookId, {
                lock: true,
            });
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
            if (book.taken_down) throw new AppError('BOOK_TAKEN_DOWN');
            if (!book.email_verified) throw new AppError('EMAIL_NOT_VERIFIED');

            // Kiểm tra xem sách có JOB xuất bản đang chạy hay không
            const runningJobId = await publishRepository.findOpenPublishJobByBookId(db, book.id);
            if (runningJobId)
                throw new AppError('JOB_IN_PROGRESS', ERROR_MESSAGES.JOB_IN_PROGRESS, {
                    jobId: runningJobId,
                });

            // Kiểm tra xem sách có thể xuất bản hay không
            const check = await this.checkBookForPublishing(db, book);
            if (check.errors.length > 0 || (check.warnings.length > 0 && !body.acceptWarnings)) {
                throw new AppError('PUBLISH_BLOCKED', ERROR_MESSAGES.PUBLISH_BLOCKED, {
                    errors: check.errors,
                    warnings: check.warnings,
                });
            }

            return {
                jobId: await publishRepository.insertPublishJob(db, bookId, userId, { visibility }),
            };
        });
    },
    // Lấy danh sách các phiên bản đã xuất bản của sách, newest version first
    async getBookVersions(userId: string, bookId: string) {
        const book = await publishRepository.findBookForPublishing(pool, userId, bookId);
        if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
        const versions = await publishRepository.getBookVersions(pool, bookId);
        return versions.map((v) =>
            VersionSchema.parse({
                id: v.id,
                versionNo: v.version_no,
                pageCount: v.page_count,
                arPageCount: v.ar_page_count,
                totalBytes: Number(v.total_size_bytes),
                publishedAt: v.published_at.toISOString(),
                publishedBy: v.published_by
                    ? { id: v.published_by, displayName: v.published_by_name }
                    : null,
            }),
        );
    },
    // Chuyển sách về trạng thái Private, link và mã QR vẫn giữ nguyên slug và hiển thị thông báo "Không khả dụng" cho đến khi sách được xuất bản lại.
    async unpublishBook(userId: string, bookId: string) {
        await withTransaction(async (db) => {
            const book = await publishRepository.findBookForPublishing(db, userId, bookId, {
                lock: true,
            });
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
            const runningJobId = await publishRepository.findOpenPublishJobByBookId(db, book.id);
            if (runningJobId)
                throw new AppError('JOB_IN_PROGRESS', ERROR_MESSAGES.JOB_IN_PROGRESS, {
                    jobId: runningJobId,
                });
            await publishRepository.setPrivate(db, book.id);
        });

        const row = await booksRepository.getBookSummary(pool, userId, bookId);
        if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
        return BookSummarySchema.parse(toSummary(row));
    },
};

export function buildPublishCheck(input: CheckInput): PublishCheck {
    const errors: PublishError[] = [];
    const warnings: PublishWarning[] = [];

    const arPageCount = input.pages.filter((p) => p.markerMode !== 'NONE').length;

    // Kiểm tra các điều kiện cơ bản để xuất bản sách như: email đã xác nhận, sách chưa bị gỡ xuống, sách có ít nhất một trang AR.
    if (!input.emailVerified)
        errors.push({
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Bạn cần xác nhận email trước khi xuất bản.',
        });
    if (input.takenDown)
        errors.push({
            code: 'BOOK_TAKEN_DOWN',
            message: 'Cuốn sách này đã bị gỡ xuống và không thể xuất bản.',
        });
    if (arPageCount === 0)
        errors.push({
            code: 'NO_AR_PAGE',
            message: 'Cuốn sách này không có trang AR nào.',
        });

    const downloads = new Map<string, number>();
    const pageIds = new Set(input.pages.map((p) => p.id));
    const similar = new Set<string>();

    for (const page of input.pages) {
        const label = `Trang ${page.orderIndex + 1}`;
        const here = { pageId: page.id };
        // Kiểm tra xem trang có ảnh hay không
        if (!page.image) {
            errors.push({
                code: 'PAGE_NO_IMAGE',
                message: `${label} không có ảnh.`,
                ...here,
            });
        }

        const files = new Map<string, CheckAsset>();

        // Kiểm tra xem các asset của trang có sẵn sàng hay không
        for (const asset of [...(page.image ? [page.image] : []), ...page.assets]) {
            files.set(asset.id, asset);
        }

        for (const asset of files.values()) {
            if (asset.status === 'PROCESSING') {
                errors.push({
                    code: 'ASSET_NOT_READY',
                    message: `${label} dùng tài nguyên chưa sẵn sàng.`,
                    ...here,
                    assetId: asset.id,
                });
            } else if (asset.status === 'FAILED') {
                errors.push({
                    code: 'ASSET_FAILED',
                    message: `${label} dùng tài nguyên bị lỗi.`,
                    ...here,
                    assetId: asset.id,
                });
            }
        }
        for (const a of page.assets) {
            downloads.set(a.id, a.sizeBytes);
        }

        if (page.markerMode === 'CUSTOM_MARKER') {
            // Kiểm tra điểm số của trang AR
            if (page.markerScore === null) {
                errors.push({
                    code: 'PAGE_NOT_SCORED',
                    message: `${label} chưa được chấm điểm.`,
                    ...here,
                });
            } else if (page.markerScore < MARKER_RULES.minPublishScore) {
                errors.push({
                    code: 'PAGE_LOW_SCORE',
                    message: `${label} có điểm AR bé hơn ${MARKER_RULES.minPublishScore}.`,
                    ...here,
                });
            }

            // Kiểm tra xem trang AR có bị nhầm lẫn với các trang khác hay không
            const report = MarkerReportSchema.safeParse(page.markerReport);
            if (report.success) {
                for (const s of report.data.similarPages) {
                    const pair = [page.id, s.pageId].sort().join(':');
                    if (!pageIds.has(s.pageId) || similar.has(pair)) continue;
                    similar.add(pair);
                    warnings.push({
                        code: 'PAGE_SIMILAR',
                        message: `${label} dễ bị nhận nhầm với một trang khác.`,
                        otherPageId: s.pageId,
                        ...here,
                    });
                }
            }
        }

        // Kiểm tra scene của trang AR
        const scene = SceneSchema.safeParse(page.scene);
        if (!scene.success) {
            errors.push({
                code: 'INTERACTION_INVALID',
                message: `${label} có scene không hợp lệ.`,
                ...here,
            });
            continue;
        }

        for (const issue of findSceneReferenceIssues(scene.data)) {
            errors.push({
                code: 'INTERACTION_INVALID',
                message: `${label} ${issue.message}`,
                interactionId: issue.interactionId,
                ...here,
            });
        }

        const bytes = page.assets.reduce((sum, a) => sum + a.sizeBytes, 0);
        for (const w of getSceneWarnings(scene.data, {
            pageAspect: input.pageAspect,
            assetBytes: bytes,
        })) {
            warnings.push({
                code: w.code,
                message: `${label}: ${w.message}`,
                ...(w.objectId ? { objectId: w.objectId } : {}),
                ...here,
            });
        }
    }
    const downloadBytes = [...downloads.values()].reduce((sum, b) => sum + b, 0);
    if (downloadBytes > LARGE_DOWNLOAD_BYTES) {
        warnings.push({
            code: 'LARGE_DOWNLOAD',
            message: `Tổng dung lượng tải xuống của sách lớn hơn ${LARGE_DOWNLOAD_BYTES / MB} MB`,
        });
    }
    return {
        canPublish: errors.length === 0,
        summary: {
            pageCount: input.pages.length,
            arPageCount,
            downloadBytes,
        },
        errors,
        warnings,
    };
}
