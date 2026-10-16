import type { Queryable } from '../../db';
import { notificationsRepository } from './notifications.repository';
import type { NotificationEvent } from './notifications.types';

export const notificationsService = {
    async notify(db: Queryable, userId: string, event: NotificationEvent) {
        return notificationsRepository.notify(db, userId, event);
    },
};
