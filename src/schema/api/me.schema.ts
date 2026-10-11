import { z } from 'zod';
import { IdSchema, PaginationQuerySchema } from '../common.schema';
import { NewPasswordSchema } from './auth.schema';

/** `PATCH /me`: every field optional, but at least one must be sent. */
export const MeUpdateBodySchema = z
    .object({
        displayName: z.string().trim().min(1).max(100).optional(),
        /** Id of an asset uploaded with `purpose = AVATAR`; null removes the avatar. */
        avatarAssetId: IdSchema.nullable().optional(),
        organization: z.string().trim().max(150).nullable().optional(),
        bio: z.string().trim().max(500).nullable().optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
        error: 'Cần gửi ít nhất một trường để sửa',
    });
export type MeUpdateBody = z.infer<typeof MeUpdateBodySchema>;

/** `PUT /me/password`. Google-only accounts have no current password, so it is optional. */
export const ChangePasswordBodySchema = z.object({
    currentPassword: z.string().trim().min(1).optional(),
    newPassword: NewPasswordSchema,
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;

export const NotificationsQuerySchema = PaginationQuerySchema.extend({
    /** `true` để chỉ lấy thông báo chưa đọc. */
    unread: z.stringbool().optional(),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuerySchema>;

export const MarkNotificationsReadBodySchema = z.union([
    z.object({ ids: z.array(IdSchema).min(1).max(100) }),
    z.object({ all: z.literal(true) }),
]);
export type MarkNotificationsReadBody = z.infer<typeof MarkNotificationsReadBodySchema>;
