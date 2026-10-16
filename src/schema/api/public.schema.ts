import { z } from 'zod';
import {
    HttpUrlSchema,
    IdSchema,
    IsoDateTimeSchema,
    LanguageSchema,
    LIMITS,
    PaginationQuerySchema,
    SceneIdSchema,
    SlugSchema,
} from '../common.schema';
import { UserRefSchema } from '../dto.schema';
import { DeviceTypeSchema, ReportReasonSchema } from '../enums.schema';

/** `GET /public/books?q=&age=&topic=&language=&sort=` (discovery page) */
export const PublicBooksQuerySchema = PaginationQuerySchema.extend({
    q: z.string().trim().max(100).optional(),
    age: z.coerce.number().int().min(0).max(18).optional(),
    topic: z.string().trim().max(50).optional(),
    language: LanguageSchema.optional(),
    sort: z.enum(['newest', 'popular']).default('newest'),
});
export type PublicBooksQuery = z.infer<typeof PublicBooksQuerySchema>;

/** A book card on the discovery page and on an author profile. */
export const PublicBookCardSchema = z.object({
    slug: SlugSchema,
    title: z.string(),
    coverUrl: HttpUrlSchema.nullable(),
    author: UserRefSchema,
    language: LanguageSchema,
    ageMin: z.int().min(0).max(18).nullable(),
    ageMax: z.int().min(0).max(18).nullable(),
    arPageCount: z.int().min(0),
});
export type PublicBookCard = z.infer<typeof PublicBookCardSchema>;

/** Public author profile. No email. */
export const PublicAuthorSchema = UserRefSchema.extend({
    organization: z.string().nullable(),
    bio: z.string().nullable(),
    avatarUrl: HttpUrlSchema.nullable(),
});

export const AuthorProfileSchema = z.object({
    author: PublicAuthorSchema,
    books: z.array(PublicBookCardSchema),
});

// --- Anonymous reading events ----------------------------------------------------

export const ViewerEventSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('OPEN'), at: IsoDateTimeSchema }),
    z.object({ type: z.literal('PAGE_FOUND'), pageId: IdSchema, at: IsoDateTimeSchema }),
    z.object({
        type: z.literal('TAP'),
        pageId: IdSchema,
        objectId: SceneIdSchema,
        at: IsoDateTimeSchema,
    }),
    z.object({ type: z.literal('SCAN_TIMEOUT'), at: IsoDateTimeSchema }),
]);
export type ViewerEvent = z.infer<typeof ViewerEventSchema>;

const eventBatchHeadSchema = {
    /** Random per book opening; never stored long-term and not linked to a person. */
    sessionId: IdSchema,
    bookVersionId: IdSchema,
    device: z.object({
        type: DeviceTypeSchema,
        os: z.string().max(20),
        browser: z.string().max(20),
    }),
};

/** The batch a Viewer builds: up to 50 events every 30 seconds, or on `sendBeacon` when the tab hides. */
export const EventBatchBodySchema = z.object({
    ...eventBatchHeadSchema,
    events: z.array(ViewerEventSchema).min(1).max(LIMITS.eventsPerBatch),
});
export type EventBatchBody = z.infer<typeof EventBatchBodySchema>;

const EventBatchEnvelopeSchema = z.object({
    ...eventBatchHeadSchema,
    events: z.array(z.unknown()).max(LIMITS.eventsPerBatch),
});

export function parseEventBatch(input: unknown): { batch: EventBatchBody; dropped: number } | null {
    const envelope = EventBatchEnvelopeSchema.safeParse(input);
    if (!envelope.success) return null;
    const events: ViewerEvent[] = [];
    for (const raw of envelope.data.events) {
        const parsed = ViewerEventSchema.safeParse(raw);
        if (parsed.success) events.push(parsed.data);
    }
    if (events.length === 0) return null;
    const { events: all, ...head } = envelope.data;
    return { batch: { ...head, events }, dropped: all.length - events.length };
}

// --- Reports  ----------------------------------------------------------------------

/** `POST /public/books/:slug/reports`. `deviceId` is hashed on the server (`reporter_fingerprint`). */
export const ReportBookBodySchema = z.object({
    reason: ReportReasonSchema,
    note: z.string().trim().max(LIMITS.reportNoteChars).optional(),
    /** Which page the problem is on (shown to the moderator; not a database column). */
    pageId: IdSchema.optional(),
    deviceId: z.string().min(8).max(100),
});
export type ReportBookBody = z.infer<typeof ReportBookBodySchema>;

export const ReportReceivedSchema = z.object({ received: z.literal(true) });
