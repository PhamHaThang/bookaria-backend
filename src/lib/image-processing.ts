import sharp from 'sharp';
import { AppError } from '../utils/api-error';

export async function renderImage(input: Uint8Array, transform: string) {
    const page = /^page-(\d+)-(\d+)$/.exec(transform);
    if (!['avatar', 'thumbnail', 'asset-preview', 'cover'].includes(transform) && !page)
        throw new Error('Biến thể ảnh không hợp lệ.');
    const preserveRatio = transform === 'cover' || transform === 'asset-preview';
    const width = page
        ? Number(page[1])
        : transform === 'avatar'
          ? 256
          : transform === 'cover'
            ? 800
            : 320;
    const height = page ? Number(page[2]) : transform === 'cover' ? undefined : width;
    if (width < 1 || width > 1600 || (height !== undefined && (height < 1 || height > 2400)))
        throw new Error('Kích thước ảnh không hợp lệ.');
    try {
        return await sharp(input, { limitInputPixels: 40_000_000 })
            .rotate()
            .resize({
                width,
                ...(height !== undefined && { height }),
                fit: page ? 'contain' : preserveRatio ? 'inside' : 'cover',
                background: 'white',
                withoutEnlargement: preserveRatio,
            })
            .flatten({ background: 'white' })
            .jpeg({ quality: page ? 94 : 85 })
            .toBuffer();
    } catch {
        throw new AppError(
            'FILE_TYPE_NOT_ALLOWED',
            'Không đọc được nội dung ảnh. Hãy chọn ảnh JPG, PNG hoặc WebP hợp lệ.',
        );
    }
}
