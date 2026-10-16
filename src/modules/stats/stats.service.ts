import { withTransaction } from '../../db';
import { type BookStats, BookStatsSchema, type StatsQuery } from '../../schema';
import { AppError } from '../../utils';
import { statsRepository } from './stats.repository';

const DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export const statsService = {
    async getTotalStats(
        userId: string,
        bookId: string,
        q: StatsQuery,
        now: Date = new Date(),
    ): Promise<BookStats> {
        const start = getSinceDate(q.range, now);
        const since = new Date(start);
        const until = new Date(start + DAYS[q.range] * DAY_MS);
        const { totals, days, pages, devices } = await withTransaction(async (db) => {
            await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            if (!(await statsRepository.isBookOwnedByUser(db, userId, bookId))) {
                throw new AppError('NOT_FOUND', 'Không tìm thấy sách');
            }
            return {
                totals: await statsRepository.getTotalStats(db, bookId, since, until),
                days: await statsRepository.getDailyOpens(db, bookId, since, until),
                pages: await statsRepository.getPageStats(db, bookId, since, until),
                devices: await statsRepository.getDeviceStats(db, bookId, since, until),
            };
        });

        const opens = new Map(days.map((d) => [d.day, d.opens]));
        return BookStatsSchema.parse({
            range: q.range,
            totals: {
                opens: totals.opens,
                sessions: totals.sessions,
                taps: totals.taps,
                scanTimeouts: totals.scan_timeouts,
            },
            opensByDay: Array.from({ length: DAYS[q.range] }, (_, i) => {
                const day = toDayString(start + i * DAY_MS);
                return { date: day, opens: opens.get(day) ?? 0 };
            }),
            byPage: pages.map((p) => ({
                pageId: p.page_id,
                pageNumber: p.page_number,
                title: p.title,
                found: p.found,
                taps: p.taps,
                scanTimeouts: 0,
            })),
            byDevice: devices,
        });
    },
};

// --- Helpers
export function getSinceDate(range: keyof typeof DAYS, now = new Date()): number {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return today - (DAYS[range] - 1) * DAY_MS;
}
function toDayString(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}
