import { randomUUID } from 'node:crypto';
import {
    applyAiObjectEdits,
    applyAiObjectProperties,
    applyAiTextAppearance,
    type InteractionAiEditOutput,
    type InteractionAiPlan,
} from '../../schema/api/interaction-ai.schema';
import {
    type Action,
    ActionSchema,
    findSceneReferenceIssues,
    type InteractionRule,
    InteractionRuleSchema,
    SceneObjectSchema,
    SceneSchema,
    WorkflowVariablesSchema,
} from '../../schema/scene.schema';
import type { GenerationContext } from './generation';

type FlowCandidate = InteractionAiEditOutput['rules'][number];

function editFlowStructure(
    old: InteractionRule | undefined,
    actions: Action[],
    edges: FlowCandidate['edges'],
    stepIds: FlowCandidate['stepIds'],
) {
    const previous = (old?.actions ?? []).map((action, index) => ({
        action,
        layout: old?.editorLayout?.[index + 1] ?? {
            id: `action-${index}`,
            x: 340 + index * 300,
            y: 80,
        },
    }));
    const byId = new Map(previous.map((step) => [step.layout.id, step]));
    if (stepIds) {
        const existing = stepIds.filter((id) => id !== null);
        if (
            !old ||
            stepIds.length !== actions.length ||
            new Set(existing).size !== existing.length ||
            existing.some((id) => !byId.has(id))
        )
            throw new Error(
                'stepIds phải khớp danh sách bước. Dùng ID cũ cho bước giữ lại và null cho bước mới.',
            );
    }
    if (!old && !edges) return {};

    const previousKeys = previous.map(({ action }) => JSON.stringify(action));
    const newKeys = actions.map((action) => JSON.stringify(action));
    const sameLength = previous.length === actions.length;
    const matches =
        stepIds ??
        newKeys.map((key, index) => {
            const from = previousKeys.indexOf(key);
            if (sameLength && previousKeys[index] === key)
                return previous[index]?.layout.id ?? null;
            return from !== -1 &&
                previousKeys.lastIndexOf(key) === from &&
                newKeys.lastIndexOf(key) === index &&
                newKeys.indexOf(key) === index
                ? (previous[from]?.layout.id ?? null)
                : null;
        });
    const used = new Set(matches);
    if (!stepIds && sameLength) {
        for (const [index, action] of actions.entries()) {
            const oldStep = previous[index];
            if (
                !matches[index] &&
                oldStep &&
                !used.has(oldStep.layout.id) &&
                oldStep.action.type === action.type
            ) {
                matches[index] = oldStep.layout.id;
                used.add(oldStep.layout.id);
            }
        }
    }
    const loop = old?.movementLoop;
    if (loop && (!used.has(loop.startId) || !used.has(loop.endId)))
        throw new Error(
            'Đoạn lặp hiện có cần giữ khối đầu và cuối. Dùng stepIds để giữ hai khối này. Muốn xóa hoặc thay cả đoạn, hãy tắt Lặp vô hạn trong Studio trước.',
        );
    const newRow = Math.min(100000, Math.max(80, ...previous.map(({ layout }) => layout.y)) + 230);
    const editorLayout = [
        old?.editorLayout?.[0] ?? { id: 'start', x: 40, y: 80 },
        ...matches.map(
            (id, index) =>
                (id && byId.get(id)?.layout) || {
                    id: old ? randomUUID() : `action-${index}`,
                    x: 340 + index * 300,
                    y: old ? newRow : 80,
                },
        ),
    ];
    const sameOrder = sameLength && matches.every((id, index) => id === previous[index]?.layout.id);
    const indexedEdges =
        edges ?? actions.map((_, index) => ({ from: index - 1, to: index, port: 'next' as const }));
    return {
        editorLayout,
        workflow:
            !edges && sameOrder && old?.workflow
                ? old.workflow
                : {
                      version: 1 as const,
                      edges: indexedEdges.map(({ from, to, port }) => {
                          const source = editorLayout[from + 1]?.id;
                          const target = editorLayout[to + 1]?.id;
                          if (!source || !target)
                              throw new Error('Dây nối trỏ tới bước không có trong luồng.');
                          return { source, target, port };
                      }),
                  },
        ...(loop ? { movementLoop: loop } : {}),
    };
}

export function compileEditPlan(
    edit: InteractionAiEditOutput,
    context: GenerationContext,
    authorText: string,
): InteractionAiPlan {
    const editor = context.editor;
    if (!editor) throw new Error('Trợ lý biên tập chưa được bật cho yêu cầu này.');
    const objectEdits = edit.objectEdits ?? [];
    const removeObjectIds = edit.removeObjectIds ?? [];
    const removeRuleIds = edit.removeRuleIds ?? [];
    const objectAdds = edit.objectAdds ?? [];
    const objectChanges = objectEdits.length + objectAdds.length + removeObjectIds.length;
    if (
        editor.selectedRuleId &&
        (objectChanges ||
            edit.rules.length + removeRuleIds.length !== 1 ||
            (edit.rules[0]?.replaceId ?? removeRuleIds[0]) !== editor.selectedRuleId ||
            (removeRuleIds.length && edit.variables.length))
    )
        throw new Error('Phạm vi đang là một luồng. Chỉ sửa hoặc xóa đúng luồng đã chọn.');
    const firstAdd = objectAdds[0];
    const editedObject =
        objectEdits[0]?.objectId ??
        removeObjectIds[0] ??
        (firstAdd && 'duplicateOf' in firstAdd ? firstAdd.duplicateOf : undefined);
    if (
        editor.selectedObjectId &&
        (edit.rules.length ||
            edit.variables.length ||
            removeRuleIds.length ||
            objectChanges !== 1 ||
            editedObject !== editor.selectedObjectId)
    )
        throw new Error(
            'Phạm vi đang là một đối tượng. Chỉ sửa, xóa hoặc nhân bản đối tượng đã chọn.',
        );
    const existingObjects = new Map(context.scene.objects.map((object) => [object.id, object]));
    const aliases = new Map<string, string>();
    const findAsset = (id: string | undefined, type: string) => {
        const asset = context.assets.find(
            (item) => item.id === id && item.type === type.toUpperCase(),
        );
        if (!asset) throw new Error('Chọn đúng loại tài nguyên đã sẵn sàng trong thư viện.');
        return asset;
    };
    const authorUrls = (authorText.match(/https?:\/\/[^\s"<>]+/giu) ?? []).flatMap((url) => [
        url,
        url.replace(/[),.!?;]+$/u, ''),
    ]);
    const checkUrl = (value: string, previous?: string) => {
        const url = new URL(value);
        if (url.username || url.password || (value !== previous && !authorUrls.includes(value)))
            throw new Error('Chỉ dùng địa chỉ HTTP(S) do tác giả nhập.');
    };
    for (const { objectId, assetId, presentation } of objectEdits) {
        if (assetId) findAsset(assetId, existingObjects.get(objectId)?.type ?? '');
        if (presentation?.kind !== 'screen') continue;
        const object = existingObjects.get(objectId);
        const current =
            object && 'presentation' in object && object.presentation?.kind === 'screen'
                ? object.presentation
                : undefined;
        if (presentation.imageAssetId && presentation.imageAssetId !== current?.imageAssetId)
            findAsset(presentation.imageAssetId, 'image');
        if (presentation.buttonUrl) checkUrl(presentation.buttonUrl, current?.buttonUrl);
    }

    const additions = objectAdds.map((item) => {
        const { localId, ...fields } = item;
        if (existingObjects.has(localId) || aliases.has(localId))
            throw new Error('Mỗi đối tượng mới cần một localId riêng.');
        const id = randomUUID();
        aliases.set(localId, id);
        if ('duplicateOf' in fields) {
            const source = existingObjects.get(fields.duplicateOf);
            if (!source || source.locked)
                throw new Error('Chọn một đối tượng có sẵn và đã mở khóa để nhân bản.');
            return SceneObjectSchema.parse({
                ...source,
                id,
                name: fields.name ?? `${source.name || source.type} (bản sao)`.slice(0, 100),
            });
        }
        const { properties, presentation, ...content } = fields;
        const media = ['model', 'image', 'video', 'audio'].includes(fields.type);
        const textual = fields.type === 'text' || fields.type === 'label';
        const asset = media ? findAsset(fields.assetId, fields.type) : undefined;
        if (
            (!media && fields.assetId) ||
            ((fields.text !== undefined || fields.style || presentation) && !textual)
        )
            throw new Error('Nội dung hoặc tài nguyên không phù hợp với loại đối tượng mới.');
        if (presentation?.kind === 'screen') {
            if (presentation.imageAssetId) findAsset(presentation.imageAssetId, 'image');
            if (presentation.buttonUrl) checkUrl(presentation.buttonUrl);
        }
        return applyAiObjectProperties(
            SceneObjectSchema.parse({
                ...content,
                id,
                name: fields.name ?? asset?.name,
                ...(textual ? { style: { color: '#252525', ...fields.style } } : {}),
                ...(presentation
                    ? {
                          presentation: applyAiTextAppearance(
                              presentation,
                              undefined,
                              fields.style?.bold,
                          ),
                      }
                    : {}),
                transform: {
                    rotation: fields.type === 'model' ? [90, 0, 0] : [0, 0, 0],
                    ...fields.transform,
                },
                ...(fields.type === 'audio'
                    ? {
                          visible: fields.visible ?? false,
                          billboard: fields.billboard ?? true,
                          autoplay: false,
                      }
                    : {}),
            }),
            properties,
        );
    });
    const resolveObject = (id: string) => aliases.get(id) ?? id;
    const objects = applyAiObjectEdits(
        context.scene.objects,
        objectEdits,
        additions,
        removeObjectIds,
    );
    const previous = new Map(context.scene.interactions.map((rule) => [rule.id, rule]));
    const removedRules = new Set(removeRuleIds);
    if (removedRules.size !== removeRuleIds.length || removeRuleIds.some((id) => !previous.has(id)))
        throw new Error('Luồng cần xóa không tồn tại hoặc bị trùng.');
    const questionOwners = new Map(
        context.scene.interactions.flatMap((rule) =>
            rule.actions.flatMap((action) =>
                action.type === 'askQuestion'
                    ? [[action.question.questionId, rule.id] as const]
                    : [],
            ),
        ),
    );
    const replacements = new Set<string>();
    const questionIds = new Map<string, string>();
    const definitions = new Map(
        WorkflowVariablesSchema.parse([...editor.variables, ...edit.variables]).map((variable) => [
            variable.key,
            variable,
        ]),
    );
    for (const flow of edit.rules) {
        if (flow.replaceId) {
            if (
                !previous.has(flow.replaceId) ||
                replacements.has(flow.replaceId) ||
                removedRules.has(flow.replaceId)
            )
                throw new Error('Mỗi luồng đang có chỉ được cập nhật một lần bằng ID trên trang.');
            replacements.add(flow.replaceId);
        }
        for (const action of flow.actions) {
            if (action.type !== 'askQuestion') continue;
            const { questionId } = action.question;
            const owner = questionOwners.get(questionId);
            if (questionIds.has(questionId) || (owner && owner !== flow.replaceId))
                throw new Error('Mã câu hỏi bị trùng. Dùng mã riêng cho mỗi câu hỏi mới.');
            questionIds.set(questionId, owner ? questionId : randomUUID());
        }
    }
    const resolveQuestion = (id: string) => questionIds.get(id) ?? id;
    const variable = (key: string, value: unknown) => {
        const def = definitions.get(key);
        if (!def || def.type !== typeof value)
            throw new Error(`Ghi nhớ "${key}" chưa được khai báo hoặc sai kiểu dữ liệu.`);
    };
    const clip = (id: string, name: string) => {
        const object = objects.find((item) => item.id === id && item.type === 'model');
        if (
            !object ||
            !('assetId' in object) ||
            !context.assets.some(
                (asset) => asset.id === object.assetId && asset.animations.includes(name),
            )
        )
            throw new Error('Tên hoạt cảnh không có trong mô hình được chọn.');
    };
    const rules = edit.rules.map(
        ({ replaceId, name, trigger, actions, edges, enabled, onRetrigger, stepIds }) => {
            const old = replaceId ? previous.get(replaceId) : undefined;
            if ('objectId' in trigger)
                trigger = { ...trigger, objectId: resolveObject(trigger.objectId) };
            if (trigger.type === 'onAnswer')
                trigger = { ...trigger, questionId: resolveQuestion(trigger.questionId) };
            if (trigger.type === 'onStateCondition') variable(trigger.test.key, trigger.test.value);
            if (trigger.type === 'onAnimationEnd' && trigger.clip)
                clip(trigger.objectId, trigger.clip);
            if (
                (trigger.type === 'onMarkerFound' || trigger.type === 'onMarkerLost') &&
                !editor.hasMarker
            )
                throw new Error('Trang chưa có marker để chạy sự kiện này.');
            const compiled = actions.map((action) => {
                if ('objectId' in action)
                    action = { ...action, objectId: resolveObject(action.objectId) };
                if (action.type === 'askQuestion') {
                    const question = action.question;
                    const previousQuestion = old?.actions.find(
                        (item) =>
                            item.type === 'askQuestion' &&
                            item.question.questionId === question.questionId,
                    );
                    const ids = new Map(
                        question.choices.map((choice) => [
                            choice.id,
                            previousQuestion?.type === 'askQuestion' &&
                            previousQuestion.question.choices.some((item) => item.id === choice.id)
                                ? choice.id
                                : randomUUID(),
                        ]),
                    );
                    return {
                        ...action,
                        question: {
                            ...question,
                            questionId: resolveQuestion(question.questionId),
                            choices: question.choices.map((choice) => ({
                                ...choice,
                                id: ids.get(choice.id),
                            })),
                            correctChoiceId: ids.get(question.correctChoiceId),
                        },
                    };
                }
                if (action.type === 'setState') variable(action.key, action.value);
                if (action.type === 'condition' || action.type === 'waitUntil') {
                    if (action.test.type === 'variable')
                        variable(action.test.key, action.test.value);
                    if (action.test.type === 'answer')
                        return {
                            ...action,
                            test: {
                                ...action.test,
                                questionId: resolveQuestion(action.test.questionId),
                            },
                        };
                    if ('objectId' in action.test)
                        return {
                            ...action,
                            test: { ...action.test, objectId: resolveObject(action.test.objectId) },
                        };
                }
                if (
                    (action.type === 'playAudio' || action.type === 'stopAudio') &&
                    action.assetId &&
                    !context.assets.some(
                        (asset) => asset.id === action.assetId && asset.type === 'AUDIO',
                    )
                )
                    throw new Error('Âm thanh không có trong tài nguyên được phép.');
                if (action.type === 'playAnimation') clip(action.objectId, action.clip);
                if (
                    action.type === 'navigate' &&
                    action.navigation.target === 'page' &&
                    !editor.pages.some((page) => page.id === action.navigation.pageId)
                )
                    throw new Error('Trang điều hướng phải thuộc sách hiện tại.');
                if (action.type === 'openUrl') {
                    const existing = old?.actions.some(
                        (item) => item.type === 'openUrl' && item.url === action.url,
                    );
                    checkUrl(action.url, existing ? action.url : undefined);
                }
                return action;
            });
            const validActions = compiled.map((action) => ActionSchema.parse(action));
            const rule = InteractionRuleSchema.parse({
                id: replaceId ?? randomUUID(),
                name,
                trigger,
                actions: validActions,
                enabled: enabled ?? old?.enabled ?? true,
                onRetrigger: onRetrigger ?? old?.onRetrigger ?? 'ignore',
                ...editFlowStructure(old, validActions, edges, stepIds),
            });
            return { replaceId, rule };
        },
    );
    const byId = new Map(rules.map((entry) => [entry.rule.id, entry.rule]));
    const scene = SceneSchema.parse({
        ...context.scene,
        objects,
        interactions: [
            ...context.scene.interactions
                .filter((rule) => !removedRules.has(rule.id))
                .map((rule) => byId.get(rule.id) ?? rule),
            ...rules.filter((entry) => !entry.replaceId).map((entry) => entry.rule),
        ],
    });
    const originalIssues = new Set(
        findSceneReferenceIssues(context.scene).map((issue) => JSON.stringify(issue)),
    );
    const issue = findSceneReferenceIssues(scene).find(
        (item) => byId.has(item.interactionId) || !originalIssues.has(JSON.stringify(item)),
    );
    if (issue) {
        const rule = scene.interactions.find(({ id }) => id === issue.interactionId);
        throw new Error(`${rule?.name ? `Luồng “${rule.name}”: ` : ''}${issue.message}`);
    }
    const swapped = new Set(
        objectEdits.filter(({ assetId }) => assetId).map(({ objectId }) => objectId),
    );
    const changedModels = new Set([
        ...swapped,
        ...additions.filter(({ type }) => type === 'model').map(({ id }) => id),
        ...objectEdits
            .filter(({ properties }) => properties?.type === 'model')
            .map(({ objectId }) => objectId),
    ]);
    for (const object of objects) {
        if (object.type !== 'model' || !changedModels.has(object.id)) continue;
        for (const name of [
            object.animation?.clip,
            object.controls?.idleClip,
            object.controls?.moveClip,
        ])
            if (name) clip(object.id, name);
    }
    for (const rule of scene.interactions) {
        const trigger = rule.trigger;
        if (trigger.type === 'onAnimationEnd' && trigger.clip && swapped.has(trigger.objectId))
            clip(trigger.objectId, trigger.clip);
        for (const action of rule.actions)
            if (action.type === 'playAnimation' && swapped.has(action.objectId))
                clip(action.objectId, action.clip);
    }
    return {
        rules,
        variables: edit.variables,
        ...(objectEdits.length ? { objectEdits } : {}),
        ...(additions.length ? { objectAdds: additions } : {}),
        ...(removeObjectIds.length ? { removeObjectIds } : {}),
        ...(removeRuleIds.length ? { removeRuleIds } : {}),
    };
}
