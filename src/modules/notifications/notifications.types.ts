import type { JobType, NotificationType } from '../../schema';

export type NotificationEvent =
    | { type: 'JOB_SUCCEEDED'; job: JobType; bookId: string; bookTitle: string }
    | { type: 'JOB_FAILED'; job: JobType; bookId: string; bookTitle: string }
    | { type: 'BOOK_TAKEN_DOWN'; bookId: string; bookTitle: string; reason: string }
    | { type: 'BOOK_REINSTATED'; bookId: string; bookTitle: string }
    | { type: 'ACCOUNT_LOCKED'; reason?: string | undefined }
    | { type: 'ACCOUNT_UNLOCKED' };

export interface NotificationContent {
    type: NotificationType;
    title: string;
    body: string | null;
    link: string | null;
}
