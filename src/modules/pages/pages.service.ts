import { createHash } from 'node:crypto';
import { pool, type Queryable, withTransaction } from '../../db';
import {
    type AddPageBody,
    AddPageResultSchema,
    BookariaMarkerResultSchema,
    type BookDraftPageChange,
    type BookDraftSnapshot,
    BookDraftSnapshotSchema,
    CustomMarkerResultSchema,
    checkMarkerPlacement,
    defaultMarkerTransform,
    ERROR_MESSAGES,
    getSceneWarnings,
    MARKER_RULES,
    MarkerInfoSchema,
    MarkerReportSchema,
    type MarkerTransform,
    MarkerTransformSchema,
    type MarkerWarning,
    type Page,
    PageSchema,
    type PageSettings,
    type PageSettingsPatch,
    PageSettingsSchema,
    PageSummarySchema,
    type ReorderPagesBody,
    type ReplacePageImageBody,
    type SaveBookDraftBody,
    SaveBookDraftResultSchema,
    type SaveSceneBody,
    type SaveSceneResult,
    SaveSceneResultSchema,
    type Scene,
    SceneSchema,
    sceneAssetIds,
    type UpdateMarkerBody,
    type UpdatePageBody,
} from '../../schema';
import { AppError, fieldError } from '../../utils';
import { assetsRepository } from '../assets/assets.repository';
import { assetsService, pageImageUrls, toAssetRef } from '../assets/assets.service';
import { booksRepository } from '../books/books.repository';
import type { EditableBook } from '../books/books.types';
import { pagesRepository } from './pages.repository';
import { type AssetKind, KIND_OF_OBJECT, type PageRow } from './pages.types';

export const pagesService = {
    async getBookDraft(userId: string, bookId: string) {
        return withTransaction(async (db) => {
            const book = await booksRepository.lockEditableBook(db, userId, bookId);
            if (!book) throw new AppError('NOT_FOUND');
            return draftSnapshot(bookId, book, await pagesRepository.getPages(db, bookId));
        });
    },
    async draftImageLayout(userId: string, bookId: string, imageAssetId: string, aspect: number) {
        if (!(await booksRepository.getDetailBook(pool, userId, bookId)))
            throw new AppError('NOT_FOUND');
        return imageLayoutOf(userId, imageAssetId, aspect);
    },
    async saveBookDraft(userId: string, bookId: string, body: SaveBookDraftBody) {
        // Verify external marker uploads before taking the book lock.
        if (!(await booksRepository.getDetailBook(pool, userId, bookId)))
            throw new AppError('NOT_FOUND');
        const checkedMinds = new Set<string>();
        for (const change of body.changes) {
            if (change.markerMindPublicId) {
                if (!(await assetsService.isMarkerFileOf(userId, change.markerMindPublicId)))
                    throw fieldError('markerMindPublicId', 'Không tìm thấy file marker của bạn.');
                checkedMinds.add(change.markerMindPublicId);
            }
            if (change.scene && Buffer.byteLength(JSON.stringify(change.scene)) > 512 * 1024)
                throw fieldError('changes', 'Nội dung của một trang vượt quá 512 KB.');
        }
        return withTransaction(async (db) => {
            const book = await booksRepository.lockEditableBook(db, userId, bookId);
            if (!book) throw new AppError('NOT_FOUND');
            await ensureNotPublishing(db, bookId);
            const rows = await pagesRepository.getPages(db, bookId);
            const snapshot = draftSnapshot(bookId, book, rows);
            const byId = new Map(rows.map((row) => [row.id, row]));
            if (snapshot.revision !== body.revision) {
                // A lost response can safely retry the same client-generated ids and content.
                if (!(await draftAlreadyApplied(db, rows, body)))
                    throw new AppError(
                        'REVISION_CONFLICT',
                        'Sách đã thay đổi ở nơi khác. Bản nháp của bạn vẫn được giữ.',
                    );
                return draftSaveResult(db, snapshot, body.changes, [], book);
            }
            const changes = new Map(body.changes.map((page) => [page.id, page]));
            const newIds = body.order.filter((id) => !byId.has(id));
            if (newIds.length) {
                const used = await db.query('SELECT id FROM pages WHERE id = ANY($1::uuid[])', [
                    newIds,
                ]);
                if (used.rows.length) throw fieldError('changes', 'Mã trang mới không hợp lệ.');
            }
            for (const id of newIds) {
                if (!changes.get(id)?.imageAssetId)
                    throw fieldError('changes', 'Trang mới cần có ảnh nền đã tải lên.');
            }
            const uses: { id: string; kind: AssetKind; path: string }[] = [];
            for (const change of body.changes) {
                if (change.imageAssetId)
                    uses.push({ id: change.imageAssetId, kind: 'IMAGE', path: 'imageAssetId' });
                if (change.scene) uses.push(...getAssetUsesInScene(change.scene));
                if (change.settings)
                    for (const key of ['backgroundAudioAssetId', 'narrationAssetId'] as const) {
                        const id = change.settings[key];
                        if (id) uses.push({ id, kind: 'AUDIO', path: `settings.${key}` });
                    }
                const row = byId.get(change.id);
                if (
                    row &&
                    change.imageAssetId &&
                    change.imageAssetId !== row.image_asset_id &&
                    row.marker_mode === 'CUSTOM_MARKER'
                ) {
                    if (!change.markerMindPublicId || !checkedMinds.has(change.markerMindPublicId))
                        throw fieldError(
                            'markerMindPublicId',
                            'Ảnh nền mới cần được biên dịch marker trước khi lưu.',
                        );
                    if (await pagesRepository.hasOpenScoreJob(db, row.id))
                        throw new AppError('JOB_IN_PROGRESS');
                }
            }
            for (const use of uses.sort((a, b) => a.id.localeCompare(b.id))) {
                if (!(await assetsService.lockAssetForUse(db, userId, use.id, use.kind)))
                    throw fieldError(
                        use.path,
                        'Tài nguyên không tồn tại, chưa sẵn sàng hoặc không thuộc thư viện của bạn.',
                    );
            }
            // Drop removed pages first so their Bookaria marker slots can be reused.
            for (const row of rows)
                if (!body.order.includes(row.id)) {
                    if (await pagesRepository.hasOpenScoreJob(db, row.id))
                        throw new AppError('JOB_IN_PROGRESS');
                    await pagesRepository.deletePage(db, row.id);
                }
            const jobs: { pageId: string; jobId: string }[] = [];
            for (const [index, id] of body.order.entries()) {
                const change = changes.get(id),
                    row = byId.get(id);
                if (!row) {
                    if (!change?.imageAssetId)
                        throw fieldError('changes', 'Trang mới thiếu ảnh nền.');
                    const marker = await prepareMarkerForPage(db, book, bookId, index);
                    await pagesRepository.insertPage(db, {
                        id,
                        bookId,
                        orderIndex: index,
                        title: change.title ?? null,
                        imageAssetId: change.imageAssetId,
                        marker,
                        scene: change.scene ?? SceneSchema.parse({ schemaVersion: 1, objects: [] }),
                        settings: change.settings ?? PageSettingsSchema.parse({}),
                    });
                } else if (change) {
                    const columns: Record<string, string | number | null> = {};
                    if (change.title !== undefined) columns.title = change.title || null;
                    if (change.imageAssetId && change.imageAssetId !== row.image_asset_id) {
                        columns.image_asset_id = change.imageAssetId;
                        if (row.marker_mode === 'CUSTOM_MARKER' && change.markerMindPublicId) {
                            await pagesRepository.setCustomMarkerFile(
                                db,
                                id,
                                change.markerMindPublicId,
                            );
                            jobs.push({
                                pageId: id,
                                jobId: await pagesRepository.insertScoreJob(db, id, userId),
                            });
                        }
                    }
                    if (Object.keys(columns).length)
                        await pagesRepository.updatePage(db, id, columns);
                    if (change.settings) await pagesRepository.setSettings(db, id, change.settings);
                    if (change.scene)
                        await pagesRepository.updateSceneAndRevision(db, id, change.scene);
                }
                if (change) {
                    const stored = await pagesRepository.loadScene(db, id);
                    await pagesRepository.replacePageAssets(
                        db,
                        id,
                        sceneAssetIds(
                            SceneSchema.parse(stored?.scene),
                            PageSettingsSchema.parse(stored?.settings),
                        ),
                    );
                }
            }
            if (body.order.length) await pagesRepository.reorderPages(db, body.order);
            await pagesRepository.updateBookUpdatedAt(db, bookId);
            const saved = draftSnapshot(bookId, book, await pagesRepository.getPages(db, bookId));
            return draftSaveResult(db, saved, body.changes, jobs, book);
        });
    },

    async getPageSummaries(db: Queryable, bookId: string) {
        return (await pagesRepository.getPages(db, bookId)).map(toPageSummary);
    },
    async getPages(userId: string, bookId: string) {
        const res = await booksRepository.getBookSummary(pool, userId, bookId);
        if (!res) throw new AppError('NOT_FOUND', 'Không tìm thấy sách này.');
        return this.getPageSummaries(pool, bookId);
    },
    async addPage(userId: string, bookId: string, body: AddPageBody) {
        return withTransaction(async (db) => {
            const book = await booksRepository.lockEditableBook(db, userId, bookId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách này.');
            await ensureNotPublishing(db, bookId);
            await lockPageImage(db, userId, body.imageAssetId);

            let orderIndex: number;
            if (body.afterPageId === undefined) {
                orderIndex = await pagesRepository.getNextOrderIndex(db, bookId);
            } else if (body.afterPageId === null) {
                orderIndex = 0;
            } else {
                const afterPage = await pagesRepository.getOrderIndexOfPage(
                    db,
                    bookId,
                    body.afterPageId,
                );
                if (afterPage === undefined)
                    throw new AppError('NOT_FOUND', 'Không tìm thấy trang này trong sách.');
                orderIndex = afterPage + 1;
            }
            await pagesRepository.shiftPagesFrom(db, bookId, orderIndex);

            const marker = await prepareMarkerForPage(db, book, bookId, orderIndex);
            const newPage = await pagesRepository.insertPage(db, {
                bookId,
                orderIndex,
                title: body.title ?? null,
                imageAssetId: body.imageAssetId,
                marker,
            });
            await pagesRepository.updateBookUpdatedAt(db, bookId);
            return AddPageResultSchema.parse({
                page: {
                    id: newPage,
                    orderIndex,
                    markerMode: marker ? 'BOOKARIA_MARKER' : 'NONE',
                    markerNumber: marker?.number ?? null,
                },
                ...(marker ? {} : { warnings: ['NO_MARKER_AVAILABLE'] }),
            });
        });
    },
    async reorderPages(userId: string, bookId: string, body: ReorderPagesBody) {
        return withTransaction(async (db) => {
            const book = await booksRepository.lockEditableBook(db, userId, bookId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy sách này.');
            await ensureNotPublishing(db, bookId);

            const pageIds = await pagesRepository.getPageIdsInOrder(db, bookId);
            const sentPageIds = new Set(body.pageIds);
            if (
                sentPageIds.size !== pageIds.length ||
                !pageIds.every((id) => sentPageIds.has(id))
            ) {
                throw fieldError(
                    'pageIds',
                    'Danh sách phải có đúng và đủ các trang của sách, mỗi trang một lần.',
                );
            }
            await pagesRepository.reorderPages(db, body.pageIds);
            await pagesRepository.updateBookUpdatedAt(db, bookId);
            return {
                pages: body.pageIds.map((id, index) => ({ id, orderIndex: index })),
            };
        });
    },
    async imageLayout(userId: string, pageId: string, aspect: number, imageAssetId?: string) {
        const page = await pagesRepository.getPageById(pool, userId, pageId);
        if (!page) throw new AppError('NOT_FOUND');
        const id = imageAssetId ?? page.image_asset_id;
        return imageLayoutOf(userId, id, aspect);
    },
    async bookImageLayouts(userId: string, bookId: string, aspect: number) {
        const book = await booksRepository.getDetailBook(pool, userId, bookId);
        if (!book) throw new AppError('NOT_FOUND');
        const pages = await pagesRepository.getPages(pool, bookId);
        return {
            pageAspect: Number(book.page_aspect),
            pages: await Promise.all(
                pages.map(async (page) => ({
                    pageId: page.id,
                    expectedImageAssetId: page.image_asset_id,
                    markerMode: page.marker_mode,
                    layout: await imageLayoutOf(userId, page.image_asset_id, aspect),
                })),
            ),
        };
    },
    async getPage(userId: string, pageId: string) {
        const pageRow = await pagesRepository.getPageById(pool, userId, pageId);
        if (!pageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
        return toPage(pool, pageRow);
    },
    async updatePage(userId: string, pageId: string, body: UpdatePageBody) {
        return withTransaction(async (db) => {
            const book = await pagesRepository.lockBookOfPage(db, userId, pageId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await ensureNotPublishing(db, book.id);
            const pageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!pageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');

            if (body.title !== undefined) {
                await pagesRepository.updatePage(db, pageId, {
                    title: body.title === '' ? null : body.title,
                });
            }

            if (body.settings !== undefined) {
                await lockAudios(db, userId, body.settings);
                const stored = await pagesRepository.loadScene(db, pageId, { lock: true });
                if (!stored) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
                const settings = mergeSettings(
                    PageSettingsSchema.parse(stored?.settings),
                    body.settings,
                );
                await pagesRepository.setSettings(db, pageId, settings);
                await pagesRepository.replacePageAssets(
                    db,
                    pageId,
                    sceneAssetIds(SceneSchema.parse(stored?.scene), settings),
                );
            }

            if (body.noAr === true && pageRow.marker_mode !== 'NONE') {
                await pagesRepository.setBookariaMarker(db, pageId, null);
            } else if (body.noAr === false && pageRow.marker_mode === 'NONE') {
                const marker = await prepareMarkerForPage(db, book, book.id, pageRow.order_index);
                if (!marker) throw new AppError('MARKER_POOL_EXHAUSTED');
                await pagesRepository.setBookariaMarker(db, pageId, marker);
            }

            await pagesRepository.updateBookUpdatedAt(db, book.id);
            const updatedPageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!updatedPageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            return toPage(db, updatedPageRow);
        });
    },

    async replacePageImage(userId: string, pageId: string, body: ReplacePageImageBody) {
        // Kiểm tra file `.mind` (gọi mạng) trước khi mở transaction, để không giữ khoá sách khi chờ.
        const current = await pagesRepository.getPageById(pool, userId, pageId);
        const mindChecked =
            current?.marker_mode === 'CUSTOM_MARKER' && body.markerMindPublicId
                ? await assetsService.isMarkerFileOf(userId, body.markerMindPublicId)
                : undefined;
        return withTransaction(async (db) => {
            const book = await pagesRepository.lockBookOfPage(db, userId, pageId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await ensureNotPublishing(db, book.id);

            const pageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!pageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await lockPageImage(db, userId, body.imageAssetId);

            let jobId: string | undefined;
            if (pageRow.marker_mode === 'CUSTOM_MARKER') {
                if (await pagesRepository.hasOpenScoreJob(db, pageId)) {
                    throw new AppError('JOB_IN_PROGRESS');
                }
                const mind = body.markerMindPublicId;
                if (!mind) {
                    throw fieldError(
                        'markerMindPublicId',
                        'Trang dùng marker riêng cần file .mind biên dịch từ ảnh mới.',
                    );
                }
                const isMarkerMindValid =
                    mindChecked ?? (await assetsService.isMarkerFileOf(userId, mind));
                if (!isMarkerMindValid) {
                    throw fieldError(
                        'markerMindPublicId',
                        'Không tìm thấy file .mind này trong thư mục tải lên của bạn.',
                    );
                }
                await pagesRepository.setCustomMarkerFile(db, pageId, mind);
                jobId = await pagesRepository.insertScoreJob(db, pageId, userId);
            }

            await pagesRepository.updatePage(db, pageId, {
                image_asset_id: body.imageAssetId,
            });
            await pagesRepository.updateBookUpdatedAt(db, book.id);

            const updatedPageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!updatedPageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            return { page: toPageSummary(updatedPageRow), ...(jobId ? { jobId } : {}) };
        });
    },
    async duplicatePage(userId: string, pageId: string) {
        return withTransaction(async (db) => {
            const book = await pagesRepository.lockBookOfPage(db, userId, pageId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await ensureNotPublishing(db, book.id);

            const pageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!pageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');

            const stored = await pagesRepository.loadScene(db, pageId, { lock: true });
            const scene = SceneSchema.parse(stored?.scene);
            const settings = PageSettingsSchema.parse(stored?.settings);

            const orderIndex = pageRow.order_index + 1;
            await pagesRepository.shiftPagesFrom(db, book.id, orderIndex);
            const sameSpot =
                pageRow.marker_mode === 'BOOKARIA_MARKER' && pageRow.marker_transform
                    ? (pageRow.marker_transform as MarkerTransform)
                    : undefined;

            const marker = await prepareMarkerForPage(db, book, book.id, orderIndex, sameSpot);
            const idNewPage = await pagesRepository.insertPage(db, {
                bookId: book.id,
                orderIndex,
                title: pageRow.title,
                imageAssetId: pageRow.image_asset_id,
                marker,
                scene,
                settings,
            });
            await pagesRepository.replacePageAssets(db, idNewPage, sceneAssetIds(scene, settings));
            await pagesRepository.updateBookUpdatedAt(db, book.id);

            const copyPageRow = await pagesRepository.getPageById(db, userId, idNewPage);
            if (!copyPageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            return {
                page: toPageSummary(copyPageRow),
            };
        });
    },
    async deletePage(userId: string, pageId: string): Promise<void> {
        return withTransaction(async (db) => {
            const book = await pagesRepository.lockBookOfPage(db, userId, pageId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await ensureNotPublishing(db, book.id);

            const pageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!pageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await pagesRepository.deletePage(db, pageId);
            await pagesRepository.closeGapAfter(db, book.id, pageRow.order_index);
            await pagesRepository.updateBookUpdatedAt(db, book.id);
        });
    },

    async getPageMarker(userId: string, pageId: string) {
        const row = await pagesRepository.getPageById(pool, userId, pageId);
        if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');

        const bookGeometry = await pagesRepository.getBookGeometry(pool, row.book_id);
        const transform = MarkerTransformSchema.safeParse(row.marker_transform);
        const warnings: MarkerWarning[] = warningsOf(row);

        if (bookGeometry && row.marker_mode === 'BOOKARIA_MARKER' && transform.success) {
            warnings.push(
                ...checkMarkerPlacement(transform.data, getBookPageGeometry(bookGeometry)).map(
                    (i) => i.code,
                ),
            );
        }
        return MarkerInfoSchema.parse({
            markerMode: row.marker_mode,
            markerNumber: row.marker_number,
            bookariaMarker:
                row.marker_number !== null && transform.success
                    ? { number: row.marker_number, transform: transform.data }
                    : null,
            markerScore: row.marker_score,
            markerReport: MarkerReportSchema.safeParse(row.marker_report).data ?? null,
            markerWarnings: warnings,
        });
    },
    /**
     * Chọn marker cho trang.
     * - BOOKARIA_MARKER: giữ nguyên số nếu trang đã có (chỉ đổi vị trí), chưa có thì lấy số trống
     *   thấp nhất. Vị trí vi phạm quy tắc về kích thước hoặc sát mép sẽ bị từ chối.
     * - CUSTOM_MARKER: ảnh của trang là marker; file `.mind` phải là của chính tác giả. Điểm số
     *   được tính sau bởi một tác vụ nên trả về 202 kèm `jobId`.
     */
    async updatePageMarker(userId: string, pageId: string, body: UpdateMarkerBody) {
        let mindChecked: boolean | undefined;
        if (body.mode === 'CUSTOM_MARKER') {
            if (!(await pagesRepository.getPageById(pool, userId, pageId))) {
                throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            }
            mindChecked = await assetsService.isMarkerFileOf(userId, body.markerMindPublicId);
        }
        return withTransaction(async (db) => {
            const book = await pagesRepository.lockBookOfPage(db, userId, pageId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await ensureNotPublishing(db, book.id);

            const pageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!pageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');

            if (body.mode === 'CUSTOM_MARKER') {
                const isMarkerFile =
                    mindChecked ??
                    (await assetsService.isMarkerFileOf(userId, body.markerMindPublicId));
                if (!isMarkerFile) {
                    throw fieldError(
                        'markerMindPublicId',
                        'Không tìm thấy file .mind này trong thư mục tải lên của bạn.',
                    );
                }
                const hasOpenScoreJob = await pagesRepository.hasOpenScoreJob(db, pageId);
                if (hasOpenScoreJob) throw new AppError('JOB_IN_PROGRESS');

                await pagesRepository.setCustomMarker(db, pageId, body.markerMindPublicId);
                const jobId = await pagesRepository.insertScoreJob(db, pageId, userId);
                await pagesRepository.updateBookUpdatedAt(db, book.id);
                return {
                    status: 202 as const,
                    data: CustomMarkerResultSchema.parse({
                        markerMode: 'CUSTOM_MARKER',
                        markerNumber: null,
                        markerScore: null,
                        jobId,
                    }),
                };
            }

            if (body.transform) {
                const issues = checkMarkerPlacement(body.transform, getBookPageGeometry(book));
                if (issues.length > 0) {
                    throw fieldError('transform', issues.map((i) => i.message).join(' '));
                }
            }

            if (pageRow.marker_mode === 'BOOKARIA_MARKER') {
                if (body.transform)
                    await pagesRepository.setMarkerTransform(db, pageId, body.transform);
            } else {
                const marker = await prepareMarkerForPage(
                    db,
                    book,
                    book.id,
                    pageRow.order_index,
                    body.transform,
                );
                if (!marker) throw new AppError('MARKER_POOL_EXHAUSTED');
                await pagesRepository.setBookariaMarker(db, pageId, marker);
            }
            await pagesRepository.updateBookUpdatedAt(db, book.id);
            const updatedPageRow = await pagesRepository.getPageById(db, userId, pageId);
            const transform = MarkerTransformSchema.safeParse(updatedPageRow?.marker_transform);
            if (!updatedPageRow || updatedPageRow.marker_number === null || !transform.success)
                throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            return {
                status: 200 as const,
                data: BookariaMarkerResultSchema.parse({
                    markerMode: 'BOOKARIA_MARKER',
                    markerNumber: updatedPageRow.marker_number,
                    transform: transform.data,
                }),
            };
        });
    },
    async rescoreMarker(userId: string, pageId: string) {
        return withTransaction(async (db) => {
            const book = await pagesRepository.lockBookOfPage(db, userId, pageId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await ensureNotPublishing(db, book.id);

            const pageRow = await pagesRepository.getPageById(db, userId, pageId);
            if (!pageRow) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            if (pageRow.marker_mode !== 'CUSTOM_MARKER') {
                throw fieldError('markerMode', 'Chỉ trang dùng marker riêng mới cần chấm điểm.');
            }
            const hasOpenScoreJob = await pagesRepository.hasOpenScoreJob(db, pageId);
            if (hasOpenScoreJob) throw new AppError('JOB_IN_PROGRESS');

            const jobId = await pagesRepository.insertScoreJob(db, pageId, userId);
            return {
                jobId,
            };
        });
    },
    async saveScene(userId: string, pageId: string, body: SaveSceneBody): Promise<SaveSceneResult> {
        return withTransaction(async (db) => {
            const book = await pagesRepository.lockBookOfPage(db, userId, pageId);
            if (!book) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            await ensureNotPublishing(db, book.id);

            const current = await pagesRepository.lockSceneRevision(db, pageId);
            if (!current) throw new AppError('NOT_FOUND', 'Không tìm thấy trang này.');
            if (current.revision !== body.revision) {
                throw new AppError('REVISION_CONFLICT', ERROR_MESSAGES.REVISION_CONFLICT, {
                    currentRevision: current.revision,
                    scene: current.scene,
                });
            }

            const assetUses = getAssetUsesInScene(body.scene).sort((a, b) =>
                a.id.localeCompare(b.id),
            );
            for (const use of assetUses) {
                if (!(await assetsService.lockAssetForUse(db, userId, use.id, use.kind))) {
                    throw fieldError(
                        use.path,
                        `Không tìm thấy tài nguyên ${use.kind.toLowerCase()} này trong thư viện của bạn.`,
                    );
                }
            }

            const stored = await pagesRepository.loadScene(db, pageId);
            const settings = PageSettingsSchema.parse(stored?.settings);
            const assetIds = sceneAssetIds(body.scene, settings);
            await pagesRepository.replacePageAssets(db, pageId, assetIds);
            const saved = await pagesRepository.updateSceneAndRevision(db, pageId, body.scene);
            await pagesRepository.updateBookUpdatedAt(db, book.id);

            return SaveSceneResultSchema.parse({
                revision: saved.revision,
                updatedAt: saved.updated_at.toISOString(),
                warnings: getSceneWarnings(body.scene, {
                    pageAspect: Number(book.page_aspect),
                    assetBytes: await pagesRepository.getAssetBytesByIds(db, assetIds),
                }),
            });
        });
    },
};
// --- Helpers ----------------------------------------------------------------------------------------------
function toPageImageUrls(r: PageRow) {
    return pageImageUrls(
        {
            resource_type: r.img_resource_type,
            original_public_id: r.img_original_public_id,
            optimized_public_id: r.img_optimized_public_id,
            format: r.img_format,
            thumbnail_url: r.img_thumbnail_url,
        },
        r.page_aspect,
    );
}
function toPageSummary(r: PageRow) {
    return PageSummarySchema.parse({
        id: r.id,
        orderIndex: r.order_index,
        title: r.title,
        thumbnailUrl: toPageImageUrls(r).thumbnailUrl,
        markerMode: r.marker_mode,
        markerNumber: r.marker_number,
        markerScore: r.marker_score,
        markerWarnings: warningsOf(r),
        objectCount: r.object_count,
    });
}
function warningsOf(r: PageRow): MarkerWarning[] {
    if (r.marker_mode !== 'CUSTOM_MARKER') return [];
    const warnings: MarkerWarning[] = [];
    if (r.marker_score === null) warnings.push('NOT_SCORED');
    else if (r.marker_score < MARKER_RULES.minPublishScore) warnings.push('LOW_SCORE');
    const report = MarkerReportSchema.safeParse(r.marker_report);
    if (report.success) {
        for (const s of report.data.similarPages) warnings.push(`SIMILAR_TO:${s.pageId}`);
    }
    return warnings;
}
async function toPage(db: Queryable, r: PageRow): Promise<Page> {
    const stored = await pagesRepository.loadScene(db, r.id);
    const assets = await pagesRepository.getPageAssets(db, r.id);
    const image = toPageImageUrls(r);
    return PageSchema.parse({
        ...toPageSummary(r),
        bookId: r.book_id,
        image: {
            assetId: r.image_asset_id,
            url: image.url,
            width: image.width,
            height: image.height,
        },
        markerReport: MarkerReportSchema.safeParse(r.marker_report).data ?? null,
        bookariaMarker:
            r.marker_number !== null && r.marker_transform
                ? { number: r.marker_number, transform: r.marker_transform }
                : null,
        settings: PageSettingsSchema.parse(stored?.settings),
        scene: SceneSchema.parse(stored?.scene),
        revision: r.revision,
        assets: Object.fromEntries(
            assets.map((a) => [
                a.id,
                toAssetRef({
                    type: a.type,
                    resource_type: a.resource_type,
                    original_public_id: a.original_public_id,
                    optimized_public_id: a.optimized_public_id,
                    format: a.format,
                    thumbnail_url: a.thumbnail_url,
                    meta: a.meta,
                }),
            ]),
        ),
        updatedAt: r.updated_at.toISOString(),
    });
}
async function ensureNotPublishing(db: Queryable, bookId: string) {
    if (await pagesRepository.hasOpenBookJob(db, bookId)) {
        throw new AppError('JOB_IN_PROGRESS');
    }
}
async function lockPageImage(db: Queryable, userId: string, assetId: string) {
    if (await assetsService.lockAssetForUse(db, userId, assetId, 'IMAGE')) return;
    if (!(await assetsService.canSeeAsset(db, userId, assetId))) {
        throw new AppError('NOT_FOUND', 'Không tìm thấy ảnh này trong thư viện của bạn.');
    }
    throw fieldError('imageAssetId', 'Tài nguyên này không phải ảnh đã sẵn sàng.');
}
function getBookPageGeometry(
    book: Pick<EditableBook, 'page_format' | 'page_aspect' | 'page_width_mm'>,
) {
    return {
        format: book.page_format,
        aspect: Number(book.page_aspect),
        widthMm: Number(book.page_width_mm),
    };
}
async function prepareMarkerForPage(
    db: Queryable,
    book: EditableBook,
    bookId: string,
    orderIndex: number,
    transform?: MarkerTransform,
) {
    const marker = await pagesRepository.getLowestFreeMarker(db, bookId);
    if (!marker) return null;
    return {
        id: marker.id,
        number: marker.number,
        transform: transform ?? defaultMarkerTransform(getBookPageGeometry(book), orderIndex),
    };
}
function mergeSettings(old: PageSettings, patch: PageSettingsPatch) {
    return PageSettingsSchema.parse({
        ...old,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    });
}
// Âm thanh của trang phải là audio của chính người dùng hoặc của thư viện chung.
async function lockAudios(db: Queryable, userId: string, patch: PageSettingsPatch) {
    for (const key of ['backgroundAudioAssetId', 'narrationAssetId'] as const) {
        const id = patch[key];
        if (
            typeof id === 'string' &&
            !(await assetsService.lockAssetForUse(db, userId, id, 'AUDIO'))
        ) {
            throw fieldError(
                `settings.${key}`,
                'Không tìm thấy file âm thanh này trong thư viện của bạn.',
            );
        }
    }
}
function getAssetUsesInScene(scene: Scene) {
    const uses: { id: string; kind: AssetKind; path: string }[] = [];
    scene.objects.forEach((o, i) => {
        if (
            (o.type === 'text' || o.type === 'label') &&
            o.presentation?.kind === 'screen' &&
            o.presentation.imageAssetId
        ) {
            uses.push({
                id: o.presentation.imageAssetId,
                kind: 'IMAGE',
                path: `scene.objects.${i}.presentation.imageAssetId`,
            });
        }
        const kind = KIND_OF_OBJECT[o.type];
        if ('assetId' in o && kind) {
            uses.push({ id: o.assetId, kind, path: `scene.objects.${i}.assetId` });
        }
    });
    scene.interactions.forEach((rule, i) => {
        rule.actions.forEach((a, j) => {
            if ((a.type === 'playAudio' || a.type === 'stopAudio') && a.assetId) {
                uses.push({
                    id: a.assetId,
                    kind: 'AUDIO',
                    path: `scene.interactions.${i}.actions.${j}.assetId`,
                });
            }
        });
    });
    return uses;
}

async function imageLayoutOf(userId: string, assetId: string, aspect: number) {
    const asset = await assetsRepository.getVisibleAsset(pool, userId, assetId);
    if (asset?.type !== 'IMAGE' || asset.status !== 'READY') throw new AppError('NOT_FOUND');
    const layout = pageImageUrls(
        {
            resource_type: asset.resource_type,
            original_public_id: asset.original_public_id,
            optimized_public_id: null,
            format: asset.format,
            thumbnail_url: null,
        },
        aspect,
    );
    return {
        assetId,
        url: layout.url,
        width: 'width' in layout ? layout.width : 0,
        height: 'height' in layout ? layout.height : 0,
    };
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
function draftSnapshot(bookId: string, book: EditableBook, rows: PageRow[]) {
    const geometry = {
        pageFormat: book.page_format,
        pageAspect: Number(book.page_aspect),
        pageWidthMm: Number(book.page_width_mm),
    };
    const authored = rows.map((row) => ({
        id: row.id,
        order: row.order_index,
        title: row.title,
        image: row.image_asset_id,
        revision: row.revision,
        settings: row.settings,
        marker: row.marker_mode,
        transform: row.marker_transform,
        mind: row.marker_mind_public_id,
    }));
    return BookDraftSnapshotSchema.parse({
        bookId,
        geometry,
        revision: createHash('sha256').update(canonical({ geometry, authored })).digest('hex'),
        pages: rows.map(toPageSummary),
        pageRevisions: Object.fromEntries(rows.map((row) => [row.id, row.revision])),
    });
}
async function draftAlreadyApplied(db: Queryable, rows: PageRow[], body: SaveBookDraftBody) {
    if (
        rows.length !== body.order.length ||
        rows.some((row, index) => row.id !== body.order[index])
    )
        return false;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const change of body.changes) {
        const row = byId.get(change.id);
        if (
            !row ||
            (change.title !== undefined && (change.title || null) !== row.title) ||
            (change.imageAssetId !== undefined && change.imageAssetId !== row.image_asset_id) ||
            (change.settings &&
                canonical(change.settings) !== canonical(PageSettingsSchema.parse(row.settings))) ||
            (change.markerMindPublicId && change.markerMindPublicId !== row.marker_mind_public_id)
        )
            return false;
        if (change.scene) {
            const stored = await pagesRepository.loadScene(db, row.id);
            if (canonical(change.scene) !== canonical(SceneSchema.parse(stored?.scene)))
                return false;
        }
    }
    return true;
}
async function draftSaveResult(
    db: Queryable,
    snapshot: BookDraftSnapshot,
    changes: BookDraftPageChange[],
    jobs: { pageId: string; jobId: string }[],
    book: EditableBook,
) {
    const pages: Page[] = [];
    const rows = await pagesRepository.getPages(db, snapshot.bookId);
    const warnings: { pageId: string; warnings: ReturnType<typeof getSceneWarnings> }[] = [];
    for (const change of changes) {
        if (!change.scene && !change.settings && !change.imageAssetId) continue;
        const row = rows.find((page) => page.id === change.id);
        if (!row) continue;
        const page = await toPage(db, row);
        pages.push(page);
        const pageWarnings = getSceneWarnings(page.scene, {
            pageAspect: Number(book.page_aspect),
            assetBytes: await pagesRepository.getAssetBytesByIds(
                db,
                sceneAssetIds(page.scene, page.settings),
            ),
        });
        if (pageWarnings.length) warnings.push({ pageId: page.id, warnings: pageWarnings });
    }
    return SaveBookDraftResultSchema.parse({ snapshot, pages, warnings, jobs });
}
