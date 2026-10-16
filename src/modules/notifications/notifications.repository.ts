import type { Queryable } from '../../db';
import type { JobType } from '../../schema';
import type { NotificationContent, NotificationEvent } from './notifications.types';

export const notificationsRepository = {
    /**
     * Tạo thông báo mới cho người dùng
     * Được gọi bởi worker khi có job hoàn tất hoặc các services khác khi có sự kiện quan trọng xảy ra
     */
    async notify(db: Queryable, userId: string, event: NotificationEvent) {
        const notification = buildNotification(event);
        const { rows } = await db.query<{ id: string }>(
            `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [userId, notification.type, notification.title, notification.body, notification.link],
        );
        return (rows[0] as { id: string }).id;
    },
};

// --- Helpers -----------------------------
const WHAT: Record<JobType, string> = {
    SCORE_MARKER: 'Chấm điểm marker',
    OPTIMIZE_ASSET: 'Tối ưu tài nguyên',
    BUILD_PREVIEW: 'Dựng bản xem trước',
    EXPORT_PDF: 'Xuất PDF in',
    PUBLISH_BOOK: 'Xuất bản',
};

const bookLink = (bookId: string) => `/books/${bookId}`;

const TITLE_MAX = 150;
const cut = (text: string, max: number) =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function buildNotification(e: NotificationEvent): NotificationContent {
    switch (e.type) {
        case 'JOB_SUCCEEDED':
            return {
                type: e.type,
                title: `${WHAT[e.job]} xong`,
                body: `Sách “${e.bookTitle}”: ${WHAT[e.job].toLowerCase()} đã hoàn tất.`,
                link: bookLink(e.bookId),
            };
        case 'JOB_FAILED':
            return {
                type: e.type,
                title: `${WHAT[e.job]} không thành công`,
                body: `Sách “${e.bookTitle}”: ${WHAT[e.job].toLowerCase()} gặp lỗi. Sách giữ nguyên như trước; bạn có thể thử lại.`,
                link: bookLink(e.bookId),
            };
        case 'BOOK_TAKEN_DOWN':
            return {
                type: e.type,
                title: cut(`Sách “${e.bookTitle}” đã bị gỡ`, TITLE_MAX),
                body: `Lý do: ${e.reason}`,
                link: bookLink(e.bookId),
            };
        case 'BOOK_REINSTATED':
            return {
                type: e.type,
                title: cut(`Sách “${e.bookTitle}” đã được khôi phục`, TITLE_MAX),
                body: 'Sách đang ở chế độ Riêng tư; bạn có thể xuất bản lại.',
                link: bookLink(e.bookId),
            };
        case 'ACCOUNT_LOCKED':
            return {
                type: e.type,
                title: 'Tài khoản của bạn đã bị khoá',
                body: e.reason ? `Lý do: ${e.reason}` : null,
                link: null,
            };
        case 'ACCOUNT_UNLOCKED':
            return {
                type: e.type,
                title: 'Tài khoản của bạn đã được mở khoá',
                body: null,
                link: null,
            };
    }
}
