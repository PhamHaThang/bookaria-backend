export interface PreviewGroup {
    group: number;
    publicId: string;
    bytes: number;
    sha256: string;
}
export interface PreviewRow {
    id: string;
    manifest: unknown;
    mind_groups: PreviewGroup[];
    expires_at: Date;
}
