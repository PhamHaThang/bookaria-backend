import type { MediaStorage } from './storage';

/** Stable JPEG geometry shared by editor, marker compilation, scoring and frozen print sources. */
export function pageImageTransform(aspect: number, maxWidth = 1600, maxHeight = 2400) {
    if (!Number.isFinite(aspect) || aspect < 0.2 || aspect > 5)
        throw new Error('Invalid page aspect');
    const width = Math.round(Math.min(maxWidth, maxHeight / aspect));
    const height = Math.min(maxHeight, Math.round(width * aspect));
    return { width, height, transform: `page-${width}-${height}` };
}
export async function pageImageDelivery(
    storage: Pick<MediaStorage, 'prepareImage'>,
    publicId: string,
    aspect: number,
    thumbnail = false,
    signal?: AbortSignal,
) {
    const layout = thumbnail ? pageImageTransform(aspect, 320, 480) : pageImageTransform(aspect);
    return {
        width: layout.width,
        height: layout.height,
        url: await storage.prepareImage(publicId, layout.transform, signal),
    };
}
