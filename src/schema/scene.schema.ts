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
    /** Shown as soon as the page opens (false = hidden until a rule shows it). */
    visible: z.boolean().default(true),
    /** Always face the camera. */
    billboard: z.boolean().default(false),
    /** Editor aid: dragging keeps the object standing on the paper. */
    snapToPaper: z.boolean().default(true),
    /** Editor-only: locked in the layer list. Ignored by the Viewer. */
    locked: z.boolean().default(false),
    /** Editor-only: hidden in the layer list. Ignored by the Viewer. */
    editorHidden: z.boolean().default(false),
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

export const ModelObjectSchema = z.object({
    ...objectBase,
    type: z.literal('model'),
    assetId: IdSchema,
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
export const TextObjectSchema = z.object({
    ...objectBase,
    type: z.literal('text'),
    text: textSchema,
    style: TextStyleSchema.prefault({}),
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
    assetId: IdSchema,
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
    /** End of the leader line, relative to the label position. */
    target: Vec3Schema.default([0, -0.1, 0]),
});

export const SceneObjectSchema = z.discriminatedUnion('type', [
    ModelObjectSchema,
    ImageObjectSchema,
    TextObjectSchema,
    VideoObjectSchema,
    AudioObjectSchema,
    HotspotObjectSchema,
    LabelObjectSchema,
]);
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type SceneObjectType = SceneObject['type'];

// ---------------------------------------------------------------------------
// Interactions: "When [trigger] then [actions...]"
// ---------------------------------------------------------------------------
export const TriggerSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('onPageEnter') }),
    z.object({ type: z.literal('onPageLeave') }),
    z.object({ type: z.literal('onTap'), objectId: SceneIdSchema }),
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
export const ActionSchema = z.discriminatedUnion('type', [
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

export const InteractionRuleSchema = z.object({
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
        rule.actions.forEach((action, i) => {
            switch (action.type) {
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
