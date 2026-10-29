import type { MediaStorage } from './cloudinary';

/** Stable JPEG geometry shared by editor, marker compilation, scoring and frozen print sources. */
export function pageImageTransform(aspect: number, maxWidth = 1600, maxHeight = 2400) {
    if (!Number.isFinite(aspect) || aspect < 0.2 || aspect > 5)
        throw new Error('Invalid page aspect');
    const width = Math.round(Math.min(maxWidth, maxHeight / aspect));
    const height = Math.round(width * aspect);
    return { width, height, transform: `c_pad,w_${width},h_${height},g_center,b_white,f_jpg,q_94` };
}
export function pageImageDelivery(
    storage: Pick<MediaStorage, 'deliveryUrl'>,
    publicId: string,
    aspect: number,
    thumbnail = false,
) {
    const layout = thumbnail ? pageImageTransform(aspect, 320, 480) : pageImageTransform(aspect);
    return {
        width: layout.width,
        height: layout.height,
        url: storage.deliveryUrl({
            resourceType: 'image',
            publicId,
            format: 'jpg',
            transform: layout.transform,
        }),
    };
}
