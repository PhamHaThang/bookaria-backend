import type { PageFormat } from '../../schema';

export const TRASH_DAYS = 30;

export const PAGE_ASPECT: Record<Exclude<PageFormat, 'CUSTOM'>, number> = {
    // biome-ignore lint/suspicious/noApproximativeNumericConstant: must equal the column default 1.4142
    A4: 1.4142,
    A5: 1.4189,
    SQUARE: 1,
};
