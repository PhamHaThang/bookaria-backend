import { z } from 'zod';

export const NARRATION_MAX_CHARACTERS = 1500;
export const NARRATION_MAX_BYTES = 20 * 1024 * 1024;
const VoiceIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/);

/** The service emits untagged MPEG-1 Layer III, 96 kbps, 48 kHz mono: 288 bytes/frame. */
export function isNarrationMp3(bytes: Uint8Array): boolean {
    if (bytes.length < 576 || bytes.length > NARRATION_MAX_BYTES || bytes.length % 288 !== 0)
        return false;
    for (let offset = 0; offset < bytes.length; offset += 288) {
        if (
            bytes[offset] !== 0xff ||
            ((bytes[offset + 1] ?? 0) & 0xfe) !== 0xfa ||
            ((bytes[offset + 2] ?? 0) & 0xfe) !== 0x74 ||
            ((bytes[offset + 3] ?? 0) & 0xc0) !== 0xc0
        )
            return false;
    }
    return true;
}

export const NarrationOptionsSchema = z.object({
    speed: z.number().min(0.8).max(1.2).default(1),
    pause: z.enum(['short', 'medium', 'long']).default('medium'),
    temperature: z.number().min(0.5).max(1).default(0.8),
    voiceStrength: z.number().min(1).max(1.5).default(1),
});
export type NarrationOptions = z.infer<typeof NarrationOptionsSchema>;

export const NarrationBodySchema = NarrationOptionsSchema.extend({
    text: z
        .string()
        .trim()
        .min(1)
        .max(NARRATION_MAX_CHARACTERS)
        .refine((value) => /[\p{L}\p{N}]/u.test(value), 'Hãy nhập nội dung cần đọc.'),
    voice: VoiceIdSchema,
});
export type NarrationBody = z.infer<typeof NarrationBodySchema>;

export const NarrationVoicesSchema = z
    .array(
        z.object({
            id: VoiceIdSchema,
            name: z.string().min(1).max(100),
        }),
    )
    .min(1)
    .max(32);
