export interface Point {
    x: number;
    y: number;
}

export interface MarkerAnalysis {
    width: number;
    height: number;
    png: Buffer;
    digest: string;
    points: Point[];
    descriptors: Uint8Array;
    cells: number[];
    features: number;
    coverage: number;
    score: number;
    hints: string[];
}

export interface MarkerSource {
    id: string;
    book_id: string;
    image_asset_id: string;
    marker_mind_public_id: string;
    original_public_id: string;
    resource_type: string;
    format: string;
    size_bytes: string;
    image_status: string;
    image_deleted: boolean;
}

export interface MarkerSnapshot {
    bookId: string;
    ownerId: string;
    targetId: string;
    pages: MarkerSource[];
}

export interface PeerComparison {
    pageId: string;
    features: number;
    coverage: number;
    hints: string[];
    similarity: number;
}
export interface Match {
    queryIdx: number;
    trainIdx: number;
    distance: number;
}
