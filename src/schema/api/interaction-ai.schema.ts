import { z } from 'zod';
import { IdSchema, SceneIdSchema } from '../common.schema';
import {
    ActionSchema,
    AudioObjectSchema,
    HotspotObjectSchema,
    ImageObjectSchema,
    InteractionRuleSchema,
    LabelObjectSchema,
    ModelControlSchema,
    ModelObjectSchema,
    SCENE_LIMITS,
    type SceneObject,
    SceneObjectSchema,
    SceneSchema,
    ScreenBorderSchema,
    TextPresentationSchema,
    TextStyleSchema,
    TransformSchema,
    TriggerSchema,
    VideoObjectSchema,
    WorkflowVariablesSchema,
} from '../scene.schema';

export const AI_TRIGGER_TYPES = ['onPageEnter', 'onPageLeave', 'onTap'] as const;
export const AI_ACTION_TYPES = [
    'playAudio',
    'stopAudio',
    'playAnimation',
    'playVideo',
    'setVisible',
    'toggleVisible',
    'transformTo',
    'wait',
] as const;

// Keep the runtime's wire fields/defaults; reject extra model-generated fields instead of stripping them.
const aiTrigger = z.union(
    TriggerSchema.options
        .filter((option) => AI_TRIGGER_TYPES.some((type) => type === option.shape.type.value))
        .map((option) => option.strict()),
);
const aiAction = z.union(
    ActionSchema.options
        .filter((option) => AI_ACTION_TYPES.some((type) => type === option.shape.type.value))
        .map((option) => option.strict()),
);

export const InteractionAiCandidateSchema = z.strictObject({
    name: z.string().trim().min(1).max(100),
    trigger: aiTrigger,
    actions: z.array(aiAction).min(1).max(SCENE_LIMITS.maxActionsPerRule),
});
const flowCandidate = z.strictObject({
    replaceId: SceneIdSchema.optional(),
    name: z.string().trim().min(1).max(100),
    trigger: z.union(TriggerSchema.options.map((option) => option.strict())),
    actions: z
        .array(z.union(ActionSchema.options.map((option) => option.strict())))
        .min(1)
        .max(SCENE_LIMITS.maxActionsPerRule),
    onRetrigger: z.enum(['ignore', 'restart']).optional(),
    enabled: z.boolean().optional(),
    stepIds: z.array(SceneIdSchema.nullable()).max(SCENE_LIMITS.maxActionsPerRule).optional(),
    edges: z
        .array(
            z.strictObject({
                from: z
                    .int()
                    .min(-1)
                    .max(SCENE_LIMITS.maxActionsPerRule - 1),
                to: z
                    .int()
                    .min(0)
                    .max(SCENE_LIMITS.maxActionsPerRule - 1),
                port: z.enum(['next', 'true', 'false']).default('next'),
            }),
        )
        .min(1)
        .max(SCENE_LIMITS.maxActionsPerRule * 2)
        .optional(),
});
const transformPatch = z.strictObject({
    position: TransformSchema.shape.position.unwrap().optional(),
    rotation: TransformSchema.shape.rotation.unwrap().optional(),
    scale: TransformSchema.shape.scale.unwrap().optional(),
});
const textStylePatch = z
    .strictObject({
        color: TextStyleSchema.shape.color.unwrap().optional(),
        size: TextStyleSchema.shape.size.unwrap().optional(),
        font: TextStyleSchema.shape.font.unwrap().optional(),
        bold: TextStyleSchema.shape.bold.unwrap().optional(),
    })
    .refine((style) => Object.keys(style).length > 0);
const [screen, bubble, extruded, annotation] = TextPresentationSchema.options;
const screenTypography = screen.shape.bodyStyle.unwrap().partial().strict().nullable().optional();
const borderPatch = z
    .strictObject({
        enabled: ScreenBorderSchema.shape.enabled.unwrap().optional(),
        color: ScreenBorderSchema.shape.color.unwrap().optional(),
        width: ScreenBorderSchema.shape.width.unwrap().optional(),
    })
    .nullable()
    .optional();
const textAppearancePatch = z.discriminatedUnion('kind', [
    screen
        .pick({ kind: true })
        .extend({
            title: screen.shape.title.unwrap().optional(),
            background: screen.shape.background.unwrap().optional(),
            imageAssetId: screen.shape.imageAssetId.unwrap().nullable().optional(),
            buttonLabel: screen.shape.buttonLabel.unwrap().optional(),
            buttonUrl: screen.shape.buttonUrl.unwrap().nullable().optional(),
            buttonBackground: screen.shape.buttonBackground.unwrap().nullable().optional(),
            titleStyle: screenTypography,
            bodyStyle: screenTypography,
            buttonStyle: screenTypography,
            border: borderPatch,
        })
        .strict(),
    bubble
        .pick({ kind: true })
        .extend({
            title: bubble.shape.title.unwrap().optional(),
            background: bubble.shape.background.unwrap().optional(),
            pointer: bubble.shape.pointer.unwrap().optional(),
            pointerPosition: bubble.shape.pointerPosition.unwrap().nullable().optional(),
            border: borderPatch,
        })
        .strict(),
    annotation
        .pick({ kind: true })
        .extend({
            background: annotation.shape.background.unwrap().optional(),
            description: annotation.shape.description.unwrap().optional(),
            descriptionColor: annotation.shape.descriptionColor,
            descriptionBackground: annotation.shape.descriptionBackground,
            shape: annotation.shape.shape.unwrap().optional(),
            connectorSide: annotation.shape.connectorSide.unwrap().nullable().optional(),
            labelOffset: annotation.shape.labelOffset.unwrap().nullable().optional(),
        })
        .strict(),
    extruded
        .pick({ kind: true })
        .extend({ depth: extruded.shape.depth.unwrap().optional() })
        .strict(),
]);
const mediaProperties = {
    autoplay: VideoObjectSchema.shape.autoplay.unwrap().optional(),
    loop: VideoObjectSchema.shape.loop.unwrap().optional(),
    volume: VideoObjectSchema.shape.volume.unwrap().optional(),
};
const modelControls = z.strictObject({
    enabled: ModelControlSchema.shape.enabled.unwrap().optional(),
    speed: ModelControlSchema.shape.speed.unwrap().optional(),
    bounds: ModelControlSchema.shape.bounds.unwrap().optional(),
    autoRotate: ModelControlSchema.shape.autoRotate.unwrap().optional(),
    forwardAxis: ModelControlSchema.shape.forwardAxis.unwrap().optional(),
    idleClip: ModelControlSchema.shape.idleClip.unwrap().nullable().optional(),
    moveClip: ModelControlSchema.shape.moveClip.unwrap().nullable().optional(),
});
const { shape: animationFields } = ModelObjectSchema.shape.animation.unwrap();
const specificProperties = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('image'),
        opacity: ImageObjectSchema.shape.opacity.unwrap().optional(),
    }),
    z.strictObject({
        type: z.literal('audio'),
        ...mediaProperties,
        audioKind: AudioObjectSchema.shape.audioKind.unwrap().nullable().optional(),
    }),
    z.strictObject({
        type: z.literal('video'),
        ...mediaProperties,
        muted: VideoObjectSchema.shape.muted.unwrap().optional(),
    }),
    z.strictObject({
        type: z.literal('hotspot'),
        size: HotspotObjectSchema.shape.size.unwrap().optional(),
        showHint: HotspotObjectSchema.shape.showHint.unwrap().optional(),
    }),
    z.strictObject({
        type: z.literal('label'),
        target: LabelObjectSchema.shape.target.unwrap().optional(),
    }),
    z.strictObject({
        type: z.literal('model'),
        controls: modelControls.nullable().optional(),
        animation: z
            .strictObject({
                clip: animationFields.clip.optional(),
                autoplay: animationFields.autoplay.unwrap().optional(),
                loop: animationFields.loop.unwrap().optional(),
            })
            .nullable()
            .optional(),
    }),
]);
const objectEdits = z
    .array(
        z
            .strictObject({
                objectId: SceneIdSchema,
                name: z.string().trim().min(1).max(100).optional(),
                visible: z.boolean().optional(),
                text: z.string().trim().min(1).max(SCENE_LIMITS.maxTextChars).optional(),
                style: textStylePatch.optional(),
                presentation: textAppearancePatch.nullable().optional(),
                properties: specificProperties.optional(),
                assetId: IdSchema.optional(),
                billboard: z.boolean().optional(),
                snapToPaper: z.boolean().optional(),
                transform: transformPatch
                    .refine((value) => Object.keys(value).length > 0)
                    .optional(),
            })
            .refine(
                ({ objectId, ...patch }) => Object.keys(patch).length > 0,
                'Đối tượng cần ít nhất một thay đổi.',
            ),
    )
    .max(12);

const resettableFields = (patch: object) =>
    Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [key, value === null ? undefined : value]),
    );

export function applyAiTextAppearance(
    patch: z.infer<typeof textAppearancePatch>,
    before?: z.infer<typeof TextPresentationSchema>,
    bold = false,
) {
    if (before && before.kind !== patch.kind)
        throw new Error('Thiết lập phải phù hợp với kiểu văn bản hiện tại.');
    const next: Record<string, unknown> = { ...before, ...resettableFields(patch) };
    if (patch.kind === 'screen') {
        const current = before?.kind === 'screen' ? before : undefined;
        const defaults = {
            titleStyle: { size: 17, weight: 600 },
            bodyStyle: { size: 14, weight: bold ? 700 : 400 },
            buttonStyle: { size: 14, weight: 600 },
        } as const;
        for (const key of ['titleStyle', 'bodyStyle', 'buttonStyle'] as const) {
            if (patch[key]) next[key] = { ...defaults[key], ...current?.[key], ...patch[key] };
        }
    }
    if ('border' in patch && patch.border)
        next.border = {
            ...(before && 'border' in before ? before.border : undefined),
            ...patch.border,
        };
    return TextPresentationSchema.parse(next);
}

export function applyAiObjectProperties(
    object: SceneObject,
    properties?: z.infer<typeof specificProperties>,
) {
    if (!properties) return object;
    if (object.type !== properties.type)
        throw new Error('Thiết lập phải phù hợp với loại đối tượng hiện tại.');
    if (properties.type === 'model' && object.type === 'model') {
        const { animation, controls } = properties;
        return SceneObjectSchema.parse({
            ...object,
            animation:
                animation === undefined
                    ? object.animation
                    : animation === null
                      ? undefined
                      : { ...object.animation, ...animation },
            controls:
                controls === undefined
                    ? object.controls
                    : controls === null
                      ? undefined
                      : { ...object.controls, ...resettableFields(controls) },
        });
    }
    return SceneObjectSchema.parse({ ...object, ...resettableFields(properties) });
}

export function applyAiObjectEdits(
    objects: SceneObject[],
    edits: z.infer<typeof objectEdits>,
    additions: SceneObject[] = [],
    removeIds: string[] = [],
) {
    const byId = new Map(objects.map((object) => [object.id, object]));
    const removed = new Set<string>();
    for (const id of removeIds) {
        const object = byId.get(id);
        if (!object || removed.has(id))
            throw new Error('Đối tượng cần xóa không tồn tại hoặc bị trùng.');
        if (object.locked) throw new Error('Mở khóa đối tượng trước khi xóa.');
        removed.add(id);
    }
    const changes = new Map<string, SceneObject>();
    for (const {
        objectId,
        name,
        visible,
        text,
        style,
        presentation,
        properties,
        transform,
        assetId,
        billboard,
        snapToPaper,
    } of edits) {
        const before = byId.get(objectId);
        if (!before || changes.has(objectId) || removed.has(objectId))
            throw new Error('Mỗi đối tượng có sẵn trên trang chỉ được sửa một lần trong đề xuất.');
        if (before.locked) throw new Error('Đối tượng đang khóa. Hãy mở khóa trong Studio trước.');
        const textObject = before.type === 'text' || before.type === 'label' ? before : undefined;
        if ((text !== undefined || style || presentation !== undefined) && !textObject)
            throw new Error('Chỉ có thể sửa nội dung và kiểu chữ của văn bản hoặc chú thích.');
        if (presentation && presentation.kind !== textObject?.presentation?.kind)
            throw new Error('Thiết lập phải phù hợp với kiểu văn bản hiện tại.');
        if (
            (style?.font !== undefined || style?.bold !== undefined) &&
            textObject?.presentation?.kind === 'extruded'
        )
            throw new Error('Chữ nổi 3D có kiểu chữ và độ đậm cố định.');
        if (assetId !== undefined && !('assetId' in before))
            throw new Error('Đối tượng này không dùng tài nguyên thư viện.');
        const after = applyAiObjectProperties(
            {
                ...before,
                ...(name === undefined ? {} : { name }),
                visible: visible ?? before.visible,
                billboard: billboard ?? before.billboard,
                snapToPaper: snapToPaper ?? before.snapToPaper,
                ...(assetId === undefined ? {} : { assetId }),
                ...(text === undefined ? {} : { text }),
                ...(textObject && style
                    ? {
                          style: {
                              color: style.color ?? textObject.style.color,
                              size: style.size ?? textObject.style.size,
                              font: style.font ?? textObject.style.font,
                              bold: style.bold ?? textObject.style.bold,
                          },
                      }
                    : {}),
                ...(presentation !== undefined
                    ? {
                          presentation: presentation
                              ? applyAiTextAppearance(
                                    presentation,
                                    textObject?.presentation,
                                    style?.bold ?? textObject?.style.bold,
                                )
                              : undefined,
                      }
                    : {}),
                transform: {
                    position: transform?.position ?? before.transform.position,
                    rotation: transform?.rotation ?? before.transform.rotation,
                    scale: transform?.scale ?? before.transform.scale,
                },
            },
            properties,
        );
        if (JSON.stringify(before) === JSON.stringify(after))
            throw new Error('Đề xuất cần thay đổi giá trị hiện tại của đối tượng.');
        changes.set(objectId, after);
    }
    for (const object of additions) {
        if (byId.has(object.id)) throw new Error('Mã đối tượng mới bị trùng.');
        byId.set(object.id, object);
    }
    return [
        ...objects
            .filter((object) => !removed.has(object.id))
            .map((object) => changes.get(object.id) ?? object),
        ...additions,
    ];
}

const objectAdd = z.strictObject({
    localId: SceneIdSchema,
    type: z.enum(['model', 'image', 'video', 'audio', 'text', 'label', 'hotspot']),
    name: z.string().trim().min(1).max(100).optional(),
    text: z.string().trim().min(1).max(SCENE_LIMITS.maxTextChars).optional(),
    style: textStylePatch.optional(),
    presentation: textAppearancePatch.optional(),
    properties: specificProperties.optional(),
    assetId: IdSchema.optional(),
    visible: z.boolean().optional(),
    billboard: z.boolean().optional(),
    snapToPaper: z.boolean().optional(),
    transform: transformPatch.optional(),
});
const objectCopy = z.strictObject({
    localId: SceneIdSchema,
    duplicateOf: SceneIdSchema,
    name: z.string().trim().min(1).max(100).optional(),
});
const removalFields = {
    removeObjectIds: z.array(SceneIdSchema).max(12).optional(),
    removeRuleIds: z.array(SceneIdSchema).max(6).optional(),
};
const hasEdits = (plan: {
    rules: unknown[];
    variables: unknown[];
    objectEdits?: unknown[] | undefined;
    objectAdds?: unknown[] | undefined;
    removeObjectIds?: unknown[] | undefined;
    removeRuleIds?: unknown[] | undefined;
}) =>
    [
        plan.rules,
        plan.variables,
        plan.objectEdits,
        plan.objectAdds,
        plan.removeObjectIds,
        plan.removeRuleIds,
    ].some((changes) => !!changes?.length);
const emptyPlanMessage = 'Đề xuất cần có ít nhất một thay đổi.';

export const InteractionAiEditOutputSchema = z
    .strictObject({
        status: z.literal('edit_plan'),
        rules: z.array(flowCandidate).max(6),
        variables: WorkflowVariablesSchema.default([]),
        objectEdits: objectEdits.optional(),
        objectAdds: z
            .array(z.union([objectAdd, objectCopy]))
            .max(12)
            .optional(),
        ...removalFields,
    })
    .refine(hasEdits, emptyPlanMessage);
export type InteractionAiEditOutput = z.infer<typeof InteractionAiEditOutputSchema>;
export const InteractionAiPlanSchema = z
    .strictObject({
        rules: z
            .array(
                z.strictObject({
                    replaceId: SceneIdSchema.optional(),
                    rule: InteractionRuleSchema,
                }),
            )
            .max(6),
        variables: WorkflowVariablesSchema,
        objectEdits: objectEdits.optional(),
        objectAdds: z.array(SceneObjectSchema).max(12).optional(),
        ...removalFields,
    })
    .refine(hasEdits, emptyPlanMessage);
export type InteractionAiPlan = z.infer<typeof InteractionAiPlanSchema>;
export const InteractionAiAnswerSchema = z.strictObject({
    status: z.literal('answer'),
    message: z.string().trim().min(1).max(2000),
});
export const InteractionAiOutputSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('proposal'), rule: InteractionAiCandidateSchema }),
    z.strictObject({
        status: z.enum(['needs_clarification', 'unsupported']),
        message: z.string().trim().min(1).max(1000),
        choices: z.array(z.string().trim().min(1).max(160)).max(4).optional(),
    }),
]);

export const InteractionAiBodySchema = z.strictObject({
    instruction: z.string().trim().min(1).max(2000),
    revision: z.int().min(0),
    scene: SceneSchema,
    audioAssetIds: z.array(IdSchema).max(60).default([]),
    history: z
        .array(
            z.strictObject({
                role: z.enum(['user', 'assistant']),
                content: z.string().trim().min(1).max(2000),
            }),
        )
        .max(20)
        .optional(),
    currentProposal: InteractionAiCandidateSchema.optional(),
    editor: z
        .strictObject({
            variables: WorkflowVariablesSchema,
            currentPlan: InteractionAiPlanSchema.optional(),
            selectedRuleId: SceneIdSchema.optional(),
            selectedObjectId: SceneIdSchema.optional(),
            assetIds: z.array(IdSchema).max(16).optional(),
        })
        .refine(({ selectedRuleId, selectedObjectId }) => !(selectedRuleId && selectedObjectId))
        .optional(),
});
export type InteractionAiBody = z.infer<typeof InteractionAiBodySchema>;

export const InteractionAiUsageSchema = z.object({
    model: z.string(),
    promptVersion: z.enum([
        'bookaria-interactions-v1',
        'bookaria-interactions-v2',
        'bookaria-interactions-v3',
        'bookaria-editor-v1',
        'bookaria-editor-v2',
        'bookaria-editor-v3',
        'bookaria-editor-v4',
        'bookaria-editor-v5',
        'bookaria-editor-v6',
        'bookaria-editor-v7',
        'bookaria-editor-v8',
        'bookaria-editor-v9',
        'bookaria-editor-v10',
        'bookaria-editor-v11',
    ]),
    attempts: z.int().min(1).max(2),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
});
export const InteractionAiResultSchema = z.discriminatedUnion('status', [
    InteractionAiAnswerSchema.extend({
        revision: z.int().min(0),
        usage: InteractionAiUsageSchema,
    }),
    z.object({
        status: z.literal('proposal'),
        rule: InteractionRuleSchema,
        revision: z.int().min(0),
        usage: InteractionAiUsageSchema,
    }),
    z.object({
        status: z.literal('edit_plan'),
        plan: InteractionAiPlanSchema,
        revision: z.int().min(0),
        usage: InteractionAiUsageSchema,
    }),
    z.object({
        status: z.enum(['needs_clarification', 'unsupported', 'invalid']),
        message: z.string().max(1000),
        choices: z.array(z.string().max(160)).max(4).optional(),
        revision: z.int().min(0),
        usage: InteractionAiUsageSchema,
    }),
]);
export type InteractionAiResult = z.infer<typeof InteractionAiResultSchema>;
