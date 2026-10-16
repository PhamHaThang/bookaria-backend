export interface TotalStatsRow {
    opens: number;
    sessions: number;
    taps: number;
    scan_timeouts: number;
}

export interface PageStatsRow {
    page_id: string;
    page_number: number;
    title: string | null;
    found: number;
    taps: number;
}
