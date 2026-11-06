import { z } from 'zod';
import { HttpUrlSchema, IdSchema, MB, SceneIdSchema, Vec3Schema } from './common.schema';
import { LightingPresetSchema } from './enums.schema';

/**
 * Scene = what an author places on one page: 3D objects and "when X then Y" rules.
 * Stored in `pages.scene` (jsonb) and copied unchanged into the published manifest.
 *
 * Coordinates: origin at the page centre, 1 unit = page width,
 *  * +X right, +Y up, +Z out of the paper. Rotation is Euler XYZ in DEGREES. glTF models are
 * Y-up, so a model standing on the page uses `rotation: [90, 0, 0]`.
 *
 * Compatibility: new optional fields are fine within a version; a breaking change bumps
 * `schemaVersion`, and old scenes are upgraded by a function, never edited by hand.
 */
export const SCENE_SCHEMA_VERSION = 1 as const;

export const SCENE_LIMITS = {
    /** Above this the editor warns (TOO_MANY_OBJECTS). */
    softMaxObjects: 20,
    /** Hard cap enforced by the schema, to protect the server. */
    hardMaxObjects: 60,
    /** Total asset size per page above which the editor warns (PAGE_HEAVY). */
    softMaxAssetBytes: 15 * MB,
    maxRules: 50,
    maxActionsPerRule: 20,
    maxTextChars: 200,
    maxDelayMs: 60_000,
    maxDurationMs: 10_000,
    /** An object centre farther than this (in page widths) outside the page edge is "off page". */
    offPageTolerance: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------
const Scale3Schema = z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]);

export const TransformSchema = z.object({
    position: Vec3Schema.prefault([0, 0, 0]),
    /** Degrees. */
    rotation: Vec3Schema.prefault([0, 0, 0]),
    scale: Scale3Schema.prefault([1, 1, 1]),
});
export type Transform = z.infer<typeof TransformSchema>;

/** Fields every object has. */
const objectBase = {
    id: SceneIdSchema,
    name: z.string().trim().max(100).optional(),
    transform: TransformSchema,
    /** Shared editor/reader visibility at page start; interaction rules may change it at runtime. */
    visible: z.boolean().default(true),
    /** Always face the camera. */
    billboard: z.boolean().default(false),
    /** Editor aid: dragging keeps the object standing on the paper. */
    snapToPaper: z.boolean().default(false),
    /** Editor-only: locked in the layer list. Ignored by the Viewer. */
    locked: z.boolean().default(false),
    /** Editor-only grouping (SC-07). */
    groupId: SceneIdSchema.optional(),
};

export const TextStyleSchema = z.object({
    /** `#rrggbb`. */
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#ffffff'),
    /** Text height in page widths. */
    size: z.number().positive().max(2).default(0.06),
    font: z.enum(['sans', 'serif', 'rounded']).default('sans'),
    bold: z.boolean().default(false),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

const textSchema = z.string().trim().min(1).max(SCENE_LIMITS.maxTextChars);

/** Reader control on the page plane; speed is page widths per second. */
export const ModelControlSchema = z.object({
    enabled: z.boolean().default(false),
    speed: z.number().min(0.01).max(5).default(0.3),
    bounds: z.enum(['page', 'free']).default('page'),
    autoRotate: z.boolean().default(true),
    /** glTF local axis pointing towards the model's front, before its authored rotation. */
    forwardAxis: z.enum(['+z', '-z', '+x', '-x', '+y', '-y']).default('+z'),
    idleClip: z.string().min(1).max(100).optional(),
    moveClip: z.string().min(1).max(100).optional(),
});
export type ModelControl = z.infer<typeof ModelControlSchema>;

export const ModelObjectSchema = z.object({
    ...objectBase,
    type: z.literal('model'),
    assetId: IdSchema,
    controls: ModelControlSchema.optional(),
    animation: z
        .object({
            clip: z.string().min(1).max(100),
            loop: z.boolean().default(false),
            autoplay: z.boolean().default(true),
        })
        .optional(),
});
export const ImageObjectSchema = z.object({
    ...objectBase,
    type: z.literal('image'),
    assetId: IdSchema,
    opacity: z.number().min(0).max(1).default(1),
});
/** Optional presentation keeps existing plain-text scenes compatible. */
const textColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const screenTextStyleSchema = z.object({
    /** Screen Text design pixels; independent from the object's scene scale. */
    size: z.number().int().min(10).max(40),
    weight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]),
    align: z.enum(['left', 'center', 'right']).optional(),
});
export const SCREEN_BORDER_DEFAULTS = { enabled: true, color: '#d4d4d4', width: 1 } as const;
export const ScreenBorderSchema = z.object({
    enabled: z.boolean().default(SCREEN_BORDER_DEFAULTS.enabled),
    color: textColorSchema.default(SCREEN_BORDER_DEFAULTS.color),
    /** Design pixels; zero is represented by enabled: false. */
    width: z.number().min(0.5).max(8).multipleOf(0.5).default(SCREEN_BORDER_DEFAULTS.width),
});
export type ScreenBorder = z.infer<typeof ScreenBorderSchema>;
export const ANNOTATION_DESCRIPTION_DEFAULTS = { color: '#ffffff', background: '#404040' } as const;
export const TextPresentationSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('screen'),
        title: z.string().trim().max(100).default(''),
        background: textColorSchema.default('#ffffff'),
        imageAssetId: IdSchema.optional(),
        buttonLabel: z.string().trim().max(60).default(''),
        buttonUrl: HttpUrlSchema.optional(),
        buttonBackground: textColorSchema.optional(),
        border: ScreenBorderSchema.optional(),
        titleStyle: screenTextStyleSchema.optional(),
        bodyStyle: screenTextStyleSchema.optional(),
        buttonStyle: screenTextStyleSchema.optional(),
    }),
    z.object({
        kind: z.literal('bubble'),
        border: ScreenBorderSchema.optional(),
        title: z.string().trim().max(100).default(''),
        background: textColorSchema.default('#ffffff'),
        pointer: z.enum(['top', 'bottom', 'left', 'right']).default('bottom'),
        /** Normalized position along the edge; omitted legacy values stay centred. */
        pointerPosition: z.number().min(0).max(1).optional(),
    }),
    z.object({ kind: z.literal('extruded'), depth: z.number().min(0.001).max(0.2).default(0.025) }),
    z.object({
        kind: z.literal('annotation'),
        /** Surface-placed callouts keep their marker at the object's transform origin. */
        anchorAtTarget: z.boolean().optional(),
        /** Label (or circle description) offset in the annotation's local XY plane, in page widths. */
        labelOffset: z.tuple([z.number(), z.number()]).optional(),
        /** Fixed midpoint of the chosen label edge. Legacy callouts infer an edge from their target. */
        connectorSide: z.enum(['left', 'right', 'top', 'bottom']).optional(),
        shape: z.enum(['line', 'circle']).default('line'),
        description: z.string().trim().max(1000).default(''),
        descriptionColor: textColorSchema.optional(),
        descriptionBackground: textColorSchema.optional(),
        background: textColorSchema.default('#f7be2d'),
    }),
]);
export type TextPresentation = z.infer<typeof TextPresentationSchema>;

export const TextObjectSchema = z.object({
    ...objectBase,
    type: z.literal('text'),
    text: textSchema,
    style: TextStyleSchema.prefault({}),
    presentation: TextPresentationSchema.optional(),
});
export const VideoObjectSchema = z.object({
    ...objectBase,
    type: z.literal('video'),
    assetId: IdSchema,
    autoplay: z.boolean().default(false),
    loop: z.boolean().default(false),
    muted: z.boolean().default(false),
    volume: z.number().min(0).max(1).default(1),
});
export const AudioObjectSchema = z.object({
    ...objectBase,
    type: z.literal('audio'),
    /** Audio keeps playing independently from its optional player card. */
    visible: z.boolean().default(false),
    assetId: IdSchema,
    /** Optional for existing scenes; cards without a kind display as BGM. */
    audioKind: z.enum(['BGM', 'SFX', 'VOICE']).optional(),
    autoplay: z.boolean().default(true),
    loop: z.boolean().default(false),
    volume: z.number().min(0).max(1).default(1),
});

/** An invisible (or hinted) touch area on the page. */
export const HotspotObjectSchema = z.object({
    ...objectBase,
    type: z.literal('hotspot'),
    /** Width and height of the touch area, in page widths. */
    size: z.tuple([z.number().positive(), z.number().positive()]).default([0.2, 0.2]),
    /** Show a pulsing ring so readers notice it. */
    showHint: z.boolean().default(true),
});

/** A callout: text plus a leader line pointing at something on the page. */
export const LabelObjectSchema = z.object({
    ...objectBase,
    type: z.literal('label'),
    text: textSchema,
    style: TextStyleSchema.prefault({}),
    presentation: TextPresentationSchema.optional(),
    /** End of the leader line, relative to the label position. */
    target: Vec3Schema.default([0, -0.1, 0]),
});

const currentSceneObjectSchema = z.discriminatedUnion('type', [
    ModelObjectSchema,
    ImageObjectSchema,
    TextObjectSchema,
    VideoObjectSchema,
    AudioObjectSchema,
    HotspotObjectSchema,
    LabelObjectSchema,
]);
/** Fold the retired editor-only flag into visibility once, then omit it from saved scenes. */
export const SceneObjectSchema = z
    .intersection(currentSceneObjectSchema, z.object({ editorHidden: z.boolean().optional() }))
    .transform(
        ({ editorHidden, ...object }): z.input<typeof currentSceneObjectSchema> => ({
            ...object,
            visible: editorHidden === true ? false : object.visible,
        }),
    )
    .pipe(currentSceneObjectSchema);
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type SceneObjectType = SceneObject['type'];

// ---------------------------------------------------------------------------
// Interactions: "When [trigger] then [actions...]"
// ---------------------------------------------------------------------------
export const TriggerSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('onPageEnter') }),
    z.object({ type: z.literal('onPageLeave') }),
    z.object({ type: z.literal('onTap'), objectId: SceneIdSchema }),
    z.object({ type: z.literal('onMarkerFound') }),
    z.object({ type: z.literal('onMarkerLost') }),
    z.object({
        type: z.literal('onAnimationEnd'),
        objectId: SceneIdSchema,
        clip: z.string().max(100).optional(),
    }),
    z.object({
        type: z.literal('onAnswer'),
        questionId: SceneIdSchema,
        answer: z.enum(['any', 'correct', 'incorrect']).default('any'),
    }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const EasingSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);
export type Easing = z.infer<typeof EasingSchema>;

/** Wait before the action starts. Every action has it. */
const delayMsSchema = z.int().min(0).max(SCENE_LIMITS.maxDelayMs).default(0);
const durationMsSchema = z.int().min(0).max(SCENE_LIMITS.maxDurationMs);

/**
 * Actions run in order: playAudio, stopAudio, playAnimation, setVisible,
 * toggleVisible, playVideo, openUrl, wait. `transformTo` is the move/rotate/scale action.
 */
export const StateKeySchema = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
        /^[a-zA-Z][a-zA-Z0-9_.:-]*$/,
        'Dùng chữ không dấu, số, dấu gạch hoặc chấm cho mã ghi nhớ.',
    );
export const StateValueSchema = z.union([
    z.boolean(),
    z.number().min(-1e9).max(1e9),
    z.string().max(500),
]);
/** Author-defined reader information. The stable key is separate from its editable Vietnamese name. */
export const WorkflowVariableSchema = z.discriminatedUnion('type', [
    z.object({
        key: StateKeySchema,
        name: z.string().trim().min(1).max(100),
        type: z.literal('number'),
        initialValue: z.number().min(-1e9).max(1e9),
    }),
    z.object({
        key: StateKeySchema,
        name: z.string().trim().min(1).max(100),
        type: z.literal('boolean'),
        initialValue: z.boolean(),
    }),
    z.object({
        key: StateKeySchema,
        name: z.string().trim().min(1).max(100),
        type: z.literal('string'),
        initialValue: z.string().max(500),
    }),
]);
export type WorkflowVariable = z.infer<typeof WorkflowVariableSchema>;
export const WorkflowVariablesSchema = z
    .array(WorkflowVariableSchema)
    .max(200)
    .superRefine((items, ctx) => {
        const keys = new Set<string>(),
            names = new Set<string>();
        items.forEach((item, index) => {
            const name = item.name.normalize('NFC').toLocaleLowerCase('vi');
            if (keys.has(item.key))
                ctx.addIssue({
                    code: 'custom',
                    path: [index, 'key'],
                    message: 'Thông tin ghi nhớ bị trùng mã.',
                });
            if (names.has(name))
                ctx.addIssue({
                    code: 'custom',
                    path: [index, 'name'],
                    message: 'Tên thông tin đã được dùng.',
                });
            keys.add(item.key);
            names.add(name);
        });
    });
export const ConditionSchema = z.discriminatedUnion('type', [
    z
        .object({
            type: z.literal('variable'),
            key: StateKeySchema,
            operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
            value: StateValueSchema,
        })
        .refine((test) => ['eq', 'ne'].includes(test.operator) || typeof test.value === 'number', {
            message: 'So sánh lớn hơn / nhỏ hơn cần một số.',
        }),
    z.object({
        type: z.literal('answer'),
        questionId: SceneIdSchema,
        result: z.enum(['correct', 'incorrect']),
    }),
    z.object({
        type: z.literal('interactionCount'),
        objectId: SceneIdSchema,
        min: z.int().min(1).max(1000000),
    }),
    z.object({ type: z.literal('visible'), objectId: SceneIdSchema, value: z.boolean() }),
]);
export type WorkflowCondition = z.infer<typeof ConditionSchema>;
export const QuestionSchema = z
    .object({
        questionId: SceneIdSchema,
        title: z.string().trim().min(1).max(500),
        choices: z
            .array(z.object({ id: SceneIdSchema, text: z.string().trim().min(1).max(200) }))
            .min(2)
            .max(6),
        correctChoiceId: SceneIdSchema,
    })
    .superRefine((question, ctx) => {
        if (
            new Set(question.choices.map((choice) => choice.id)).size !== question.choices.length ||
            !question.choices.some((choice) => choice.id === question.correctChoiceId)
        )
            ctx.addIssue({
                code: 'custom',
                message: 'Đáp án phải có mã riêng và có một đáp án đúng trong danh sách.',
            });
    });
export type WorkflowQuestion = z.infer<typeof QuestionSchema>;
export const NavigationSchema = z
    .object({
        target: z.enum(['page', 'next', 'previous', 'end']),
        pageId: IdSchema.optional(),
        message: z.string().trim().max(500).optional(),
    })
    .refine((navigation) => navigation.target !== 'page' || !!navigation.pageId, {
        message: 'Chọn trang cần chuyển đến.',
    });
export type WorkflowNavigation = z.infer<typeof NavigationSchema>;

export const ActionSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('controlModel'),
        objectId: SceneIdSchema,
        operation: z.enum(['enable', 'disable', 'reset']).default('enable'),
        delayMsSchema,
    }),
    z.object({
        type: z.literal('playAudio'),
        assetId: IdSchema,
        loop: z.boolean().default(false),
        volume: z.number().min(0).max(1).default(1),
        delayMsSchema,
    }),
    /** Without `assetId`, stops every audio of the page. */
    z.object({ type: z.literal('stopAudio'), assetId: IdSchema.optional(), delayMsSchema }),
    z.object({
        type: z.literal('playAnimation'),
        objectId: SceneIdSchema,
        clip: z.string().min(1).max(100),
        loop: z.boolean().default(false),
        delayMsSchema,
    }),
    z.object({
        type: z.literal('setVisible'),
        objectId: SceneIdSchema,
        value: z.boolean(),
        /** Fade time; 0 = instant. */
        durationMs: durationMsSchema.default(0),
        delayMsSchema,
    }),
    z.object({
        type: z.literal('toggleVisible'),
        objectId: SceneIdSchema,
        durationMs: durationMsSchema.default(0),
        delayMsSchema,
    }),
    z.object({ type: z.literal('playVideo'), objectId: SceneIdSchema, delayMsSchema }),
    z.object({ type: z.literal('openUrl'), url: HttpUrlSchema, delayMsSchema }),
    z.object({ type: z.literal('condition'), test: ConditionSchema, delayMsSchema }),
    z
        .object({
            type: z.literal('setState'),
            key: StateKeySchema,
            operation: z.enum(['set', 'increment', 'toggle']),
            value: StateValueSchema,
            delayMsSchema,
        })
        .superRefine((action, ctx) => {
            if (
                (action.operation === 'increment' && typeof action.value !== 'number') ||
                (action.operation === 'toggle' && typeof action.value !== 'boolean')
            )
                ctx.addIssue({
                    code: 'custom',
                    message: 'Tăng điểm cần một số; bật/tắt cần giá trị đúng/sai.',
                });
        }),
    z.object({ type: z.literal('askQuestion'), question: QuestionSchema, delayMsSchema }),
    z.object({ type: z.literal('navigate'), navigation: NavigationSchema, delayMsSchema }),
    z.object({ type: z.literal('wait'), ms: z.int().min(0).max(SCENE_LIMITS.maxDelayMs) }),
    z
        .object({
            type: z.literal('transformTo'),
            objectId: SceneIdSchema,
            position: Vec3Schema.optional(),
            rotation: Vec3Schema.optional(),
            scale: Scale3Schema.optional(),
            durationMs: durationMsSchema.default(500),
            easing: EasingSchema.default('easeInOut'),
            delayMsSchema,
        })
        .refine(
            (a) => a.position !== undefined || a.rotation !== undefined || a.scale !== undefined,
            {
                error: 'Cần ít nhất một trong vị trí, góc xoay hoặc tỉ lệ đích',
            },
        ),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];

export const InteractionRuleSchema = z
    .object({
        id: SceneIdSchema,
        name: z.string().trim().max(100).optional(),
        /** Disabled rules are kept but never run (TT-06). */
        enabled: z.boolean().default(true),
        trigger: TriggerSchema,
        actions: z.array(ActionSchema).min(1).max(SCENE_LIMITS.maxActionsPerRule),
        /**
         * What happens when the trigger fires again while the actions are still running:
         * `ignore` (default) or `restart` from the first action.
         */
        onRetrigger: z.enum(['ignore', 'restart']).default('ignore'),
        /** Connected workflow v1; absent on legacy sequential rules. */
        workflow: z
            .object({
                version: z.literal(1),
                edges: z
                    .array(
                        z.object({
                            source: SceneIdSchema,
                            target: SceneIdSchema,
                            port: z.enum(['next', 'true', 'false']).default('next'),
                        }),
                    )
                    .min(1)
                    .max(SCENE_LIMITS.maxActionsPerRule * 2),
            })
            .optional(),
        /** Stable node ids and positions. actions[i] belongs to editorLayout[i+1]. */
        editorLayout: z
            .array(
                z.object({
                    id: SceneIdSchema,
                    x: z.number().min(-100000).max(100000),
                    y: z.number().min(-100000).max(100000),
                }),
            )
            .min(1)
            .max(SCENE_LIMITS.maxActionsPerRule + 1)
            .optional(),
    })
    .superRefine((rule, ctx) => {
        const problem = (message: string) =>
            ctx.addIssue({ code: 'custom', path: ['workflow'], message });
        if (!rule.workflow && rule.actions.some((action) => action.type === 'condition'))
            problem('Điều kiện cần luồng có nhánh Đúng và Sai.');
        if (
            rule.trigger.type === 'onPageLeave' &&
            rule.actions.some(
                (action) => action.type === 'navigate' || action.type === 'askQuestion',
            )
        )
            problem('Câu hỏi và chuyển trang cần chạy trước khi rời trang.');
        if (rule.workflow && !rule.editorLayout) problem('Luồng cần danh sách mã node và vị trí.');
        if (!rule.editorLayout) return;
        if (
            rule.editorLayout.length !== rule.actions.length + 1 ||
            rule.editorLayout[0]?.id !== 'start' ||
            new Set(rule.editorLayout.map((node) => node.id)).size !== rule.editorLayout.length
        )
            ctx.addIssue({
                code: 'custom',
                path: ['editorLayout'],
                message: 'Bố cục phải có một điểm bắt đầu và một vị trí cho mỗi hành động.',
            });
        if (!rule.workflow) return;
        const nodeIds = rule.editorLayout.map((node) => node.id);
        const actionById = new Map(
            rule.actions.map((action, index) => [nodeIds[index + 1] || `action-${index}`, action]),
        );
        const output = new Map<string, Set<string>>();
        const links = new Map<string, string[]>();
        for (const edge of rule.workflow.edges) {
            if (
                !nodeIds.includes(edge.source) ||
                !nodeIds.includes(edge.target) ||
                edge.target === 'start'
            ) {
                problem('Dây nối trỏ đến node không hợp lệ.');
                continue;
            }
            const condition = actionById.get(edge.source)?.type === 'condition';
            if (condition ? edge.port === 'next' : edge.port !== 'next')
                problem('Chọn đúng cổng ra của node.');
            const ports = output.get(edge.source) || new Set<string>();
            if (ports.has(edge.port)) problem('Mỗi cổng chỉ nối đến một bước.');
            ports.add(edge.port);
            output.set(edge.source, ports);
            links.set(edge.source, [...(links.get(edge.source) || []), edge.target]);
        }
        if (!output.get('start')?.has('next')) problem('Nối sự kiện bắt đầu với bước đầu tiên.');
        for (const [id, action] of actionById) {
            if (action.type === 'condition' && output.get(id)?.size !== 2)
                problem('Điều kiện cần cả nhánh Đúng và Sai.');
            if (action.type === 'navigate' && output.has(id))
                problem('Chuyển trang là bước cuối của nhánh.');
        }
        const visiting = new Set<string>(),
            visited = new Set<string>();
        const visit = (id: string) => {
            if (visiting.has(id)) {
                problem('Không hỗ trợ vòng lặp trong luồng.');
                return;
            }
            if (visited.has(id)) return;
            visiting.add(id);
            for (const next of links.get(id) || []) visit(next);
            visiting.delete(id);
            visited.add(id);
        };
        visit('start');
        if (visited.size !== nodeIds.length) problem('Có node chưa nối từ sự kiện bắt đầu.');
    });
export type InteractionRule = z.infer<typeof InteractionRuleSchema>;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
/**
 * Structural validation only: ids are unique and sizes are bounded.
 * References are NOT checked here on purpose: when an author deletes an object, the rules that
 * pointed at it stay in the scene and are flagged as errors until fixed.
 * `findSceneReferenceIssues` reports them; `PublishedScene` rejects them.
 */
export const SceneSchema = z
    .object({
        schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
        objects: z.array(SceneObjectSchema).max(SCENE_LIMITS.hardMaxObjects),
        interactions: z.array(InteractionRuleSchema).max(SCENE_LIMITS.maxRules).default([]),
    })
    .superRefine((scene, ctx) => {
        const report = (kind: 'objects' | 'interactions', ids: string[]) => {
            const seen = new Set<string>();
            ids.forEach((id, index) => {
                if (seen.has(id)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: [kind, index, 'id'],
                        message: `Mã "${id}" bị trùng`,
                    });
                }
                seen.add(id);
            });
        };
        report(
            'objects',
            scene.objects.map((o) => o.id),
        );
        report(
            'interactions',
            scene.interactions.map((r) => r.id),
        );
    });
export type Scene = z.infer<typeof SceneSchema>;
export type SceneInput = z.input<typeof SceneSchema>;

// ---------------------------------------------------------------------------
// Page settings: page-level audio and lighting
// ---------------------------------------------------------------------------

export const PageSettingsSchema = z.object({
    backgroundAudioAssetId: IdSchema.nullable().default(null),
    backgroundLoop: z.boolean().default(true),
    /** Voice-over played after the reader taps Start (VW-06). */
    narrationAssetId: IdSchema.nullable().default(null),
    lighting: LightingPresetSchema.default('neutral'),
});
export type PageSettings = z.infer<typeof PageSettingsSchema>;

// ---------------------------------------------------------------------------
// Reference checks and warnings
// ---------------------------------------------------------------------------

export interface SceneReferenceIssue {
    interactionId: string;
    /** Index of the action inside the rule, or null when the trigger is the problem. */
    actionIndex: number | null;
    message: string;
}

/**
 * Finds rules that point at missing or wrong-typed objects. Used by the Studio to flag rules
 * and by `publish-check` (error code `INTERACTION_INVALID`).
 */
export function findSceneReferenceIssues(scene: Scene): SceneReferenceIssue[] {
    const objects = new Map(scene.objects.map((o) => [o.id, o]));
    const issues: SceneReferenceIssue[] = [];
    const questionIds = new Set(
        scene.interactions.flatMap((rule) =>
            rule.actions.flatMap((action) =>
                action.type === 'askQuestion' ? [action.question.questionId] : [],
            ),
        ),
    );
    const seenQuestions = new Set<string>();

    const need = (
        rule: InteractionRule,
        actionIndex: number | null,
        objectId: string,
        allowed: readonly SceneObjectType[] | null,
        what: string,
    ) => {
        const target = objects.get(objectId);
        if (!target) {
            issues.push({
                interactionId: rule.id,
                actionIndex,
                message: 'Quy tắc trỏ tới đối tượng đã xoá',
            });
        } else if (allowed && !allowed.includes(target.type)) {
            issues.push({
                interactionId: rule.id,
                actionIndex,
                message: `Đối tượng "${target.name ?? target.id}" không dùng được cho ${what}`,
            });
        }
    };

    for (const rule of scene.interactions) {
        if (rule.trigger.type === 'onTap') {
            need(
                rule,
                null,
                rule.trigger.objectId,
                ['model', 'image', 'text', 'video', 'hotspot', 'label'],
                'sự kiện chạm',
            );
        }
        if (rule.trigger.type === 'onAnimationEnd')
            need(rule, null, rule.trigger.objectId, ['model'], 'kết thúc hoạt ảnh');
        if (rule.trigger.type === 'onAnswer') {
            const questionId = rule.trigger.questionId;
            if (
                !scene.interactions.some((item) =>
                    item.actions.some(
                        (action) =>
                            action.type === 'askQuestion' &&
                            action.question.questionId === questionId,
                    ),
                )
            )
                issues.push({
                    interactionId: rule.id,
                    actionIndex: null,
                    message: 'Chọn câu hỏi có trong trang này.',
                });
        }
        rule.actions.forEach((action, i) => {
            if (action.type === 'askQuestion') {
                if (seenQuestions.has(action.question.questionId))
                    issues.push({
                        interactionId: rule.id,
                        actionIndex: i,
                        message: 'Mỗi câu hỏi cần một mã riêng.',
                    });
                seenQuestions.add(action.question.questionId);
            }
            if (
                action.type === 'condition' &&
                action.test.type === 'answer' &&
                !questionIds.has(action.test.questionId)
            )
                issues.push({
                    interactionId: rule.id,
                    actionIndex: i,
                    message: 'Điều kiện trỏ tới câu hỏi không có trong trang.',
                });
            if (action.type === 'condition' && 'objectId' in action.test)
                need(rule, i, action.test.objectId, null, 'điều kiện');
            switch (action.type) {
                case 'controlModel':
                    need(rule, i, action.objectId, ['model'], 'điều khiển mô hình');
                    break;
                case 'playAnimation':
                    need(rule, i, action.objectId, ['model'], 'chạy animation');
                    break;
                case 'playVideo':
                    need(rule, i, action.objectId, ['video'], 'phát video');
                    break;
                case 'setVisible':
                case 'toggleVisible':
                case 'transformTo':
                    need(rule, i, action.objectId, null, 'hành động này');
                    break;
                default:
                    break;
            }
        });
    }
    return issues;
}

/** The scene that goes into a published manifest: no dangling references allowed. */
export const PublishedSceneSchema = SceneSchema.superRefine((scene, ctx) => {
    for (const issue of findSceneReferenceIssues(scene)) {
        ctx.addIssue({
            code: 'custom',
            path: ['interactions', issue.interactionId],
            message: issue.message,
        });
    }
});

/** Every asset id a page uses: objects, audio actions and page settings. Keeps `page_assets` in sync. */
export function sceneAssetIds(scene: Scene, settings?: PageSettings): string[] {
    const ids = new Set<string>();
    for (const o of scene.objects) {
        if ('assetId' in o) ids.add(o.assetId);
        if (
            (o.type === 'text' || o.type === 'label') &&
            o.presentation?.kind === 'screen' &&
            o.presentation.imageAssetId
        )
            ids.add(o.presentation.imageAssetId);
    }
    for (const rule of scene.interactions) {
        for (const a of rule.actions) {
            if (a.type === 'playAudio') ids.add(a.assetId);
            if (a.type === 'stopAudio' && a.assetId) ids.add(a.assetId);
        }
    }
    if (settings?.backgroundAudioAssetId) ids.add(settings.backgroundAudioAssetId);
    if (settings?.narrationAssetId) ids.add(settings.narrationAssetId);
    return [...ids];
}
export const SceneWarningCodeSchema = z.enum(['PAGE_HEAVY', 'TOO_MANY_OBJECTS', 'OBJECT_OFF_PAGE']);
export type SceneWarningCode = z.infer<typeof SceneWarningCodeSchema>;

/** Non-blocking warning returned when saving a scene and shown in `publish-check`. */
export const SceneWarningSchema = z.object({
    code: SceneWarningCodeSchema,
    message: z.string(),
    objectId: SceneIdSchema.optional(),
});
export type SceneWarning = z.infer<typeof SceneWarningSchema>;

export function getSceneWarnings(
    scene: Scene,
    opts: { pageAspect: number; assetBytes?: number },
): SceneWarning[] {
    const warnings: SceneWarning[] = [];
    if ((opts.assetBytes ?? 0) > SCENE_LIMITS.softMaxAssetBytes) {
        warnings.push({ code: 'PAGE_HEAVY', message: 'Tài nguyên của trang vượt 15 MB' });
    }
    if (scene.objects.length > SCENE_LIMITS.softMaxObjects) {
        warnings.push({
            code: 'TOO_MANY_OBJECTS',
            message: `Trang có hơn ${SCENE_LIMITS.softMaxObjects} đối tượng`,
        });
    }
    const limitX = 0.5 + SCENE_LIMITS.offPageTolerance;
    const limitY = opts.pageAspect / 2 + SCENE_LIMITS.offPageTolerance;
    for (const o of scene.objects) {
        if (o.type === 'audio') continue;
        const [x, y] = o.transform.position;
        if (Math.abs(x) > limitX || Math.abs(y) > limitY) {
            warnings.push({
                code: 'OBJECT_OFF_PAGE',
                message: `"${o.name ?? o.id}" nằm xa mép trang, người đọc khó thấy khi quét`,
                objectId: o.id,
            });
        }
    }
    return warnings;
}
