import { pool } from '../../db';
import {
    type InteractionAiBody,
    InteractionAiResultSchema,
} from '../../schema/api/interaction-ai.schema';
import { AssetMetaSchema } from '../../schema/asset.schema';
import { pageWidthMm } from '../../schema/marker.schema';
import { SCENE_LIMITS } from '../../schema/scene.schema';
import { AppError, fieldError } from '../../utils/api-error';
import { assetsRepository } from '../assets/assets.repository';
import { pagesRepository } from '../pages/pages.repository';
import { type CapabilityAsset, proposeInteraction } from './generation';
import { completeInteraction } from './provider';

// shortcut: limits are per API process; use a shared limiter before deploying multiple replicas.
const activeUsers = new Set<string>();

async function checkPage(userId: string, pageId: string, revision: number) {
    const page = await pagesRepository.getPageById(pool, userId, pageId);
    if (!page)
        throw new AppError(
            'NOT_FOUND',
            'Không tìm thấy trang. Nếu đây là trang mới, hãy lưu sách trước khi dùng AI.',
        );
    if (page.revision !== revision)
        throw new AppError(
            'REVISION_CONFLICT',
            'Trang đã thay đổi trên máy chủ. Hãy tải lại trang rồi tạo đề xuất mới.',
            { currentRevision: page.revision },
        );
    return page;
}

export async function createInteractionProposal(
    userId: string,
    pageId: string,
    body: InteractionAiBody,
    signal?: AbortSignal,
) {
    const page = await checkPage(userId, pageId, body.revision);
    if (
        body.editor?.selectedRuleId &&
        !body.scene.interactions.some((rule) => rule.id === body.editor?.selectedRuleId)
    )
        throw fieldError(
            'editor.selectedRuleId',
            'Luồng đã chọn không còn trên trang. Hãy chọn lại phạm vi.',
        );
    if (
        body.editor?.selectedObjectId &&
        !body.scene.objects.some((object) => object.id === body.editor?.selectedObjectId)
    )
        throw fieldError(
            'editor.selectedObjectId',
            'Đối tượng đã chọn không còn trên trang. Hãy chọn lại phạm vi.',
        );
    if (
        body.scene.interactions.length >= SCENE_LIMITS.maxRules &&
        !body.currentProposal &&
        !body.editor
    )
        throw fieldError('scene.interactions', 'Trang đã đạt giới hạn 50 luồng tương tác.');
    if (activeUsers.has(userId) || activeUsers.size >= 2)
        throw new AppError('RATE_LIMITED', 'AI đang xử lý yêu cầu khác. Vui lòng chờ.', {
            retryAfterSeconds: 10,
        });
    activeUsers.add(userId);
    try {
        const required = new Map<string, string | undefined>();
        const add = (id: string, type: string) => {
            if (required.has(id) && required.get(id) !== type)
                throw fieldError('scene.objects', 'Tài nguyên được dùng với loại không phù hợp.');
            required.set(id, type);
        };
        for (const object of body.scene.objects) {
            if ('assetId' in object)
                add(object.assetId, object.type === 'model' ? 'MODEL' : object.type.toUpperCase());
            if (
                'presentation' in object &&
                object.presentation?.kind === 'screen' &&
                object.presentation.imageAssetId
            )
                add(object.presentation.imageAssetId, 'IMAGE');
        }
        for (const id of body.audioAssetIds) add(id, 'AUDIO');
        for (const id of body.editor?.assetIds ?? [])
            if (!required.has(id)) required.set(id, undefined);
        const [availableAssets, pages, geometry] = await Promise.all([
            assetsRepository.readyAssetMetadata(pool, userId, [...required.keys()]),
            body.editor ? pagesRepository.getPages(pool, page.book_id) : [],
            body.editor ? pagesRepository.getBookGeometry(pool, page.book_id) : undefined,
        ]);
        const byId = new Map(availableAssets.map((asset) => [asset.id, asset]));
        const assets: CapabilityAsset[] = [];
        for (const [id, type] of required) {
            const asset = byId.get(id.toLowerCase());
            if (!asset || (type && asset.type !== type))
                throw fieldError(
                    'scene',
                    'Có tài nguyên không sẵn sàng hoặc bạn không có quyền sử dụng.',
                );
            const meta = AssetMetaSchema.parse(asset.meta);
            assets.push({
                id,
                type: asset.type,
                name: asset.name.slice(0, 100),
                animations: asset.type === 'MODEL' ? (meta.animations ?? []) : [],
            });
        }
        const context = {
            scene: body.scene,
            assets,
            ...(body.editor
                ? {
                      editor: {
                          variables: body.editor.variables,
                          pages: pages.map(({ id, title }) => ({ id, title })),
                          hasMarker: page.marker_mode !== 'NONE',
                          ...(geometry
                              ? {
                                    pageWidthMm: pageWidthMm(
                                        geometry.page_format,
                                        Number(geometry.page_width_mm),
                                    ),
                                }
                              : {}),
                          selectedRuleId: body.editor.selectedRuleId,
                          selectedObjectId: body.editor.selectedObjectId,
                      },
                  }
                : {}),
        };
        const conversation =
            body.history || body.currentProposal || body.editor
                ? {
                      history: body.history,
                      currentProposal: body.currentProposal,
                      editor: body.editor,
                  }
                : undefined;
        signal?.throwIfAborted();
        const result = await proposeInteraction(
            completeInteraction,
            body.instruction,
            context,
            signal,
            conversation,
        );
        await checkPage(userId, pageId, body.revision);
        return InteractionAiResultSchema.parse({
            ...result.output,
            usage: result.usage,
            revision: body.revision,
        });
    } finally {
        activeUsers.delete(userId);
    }
}
