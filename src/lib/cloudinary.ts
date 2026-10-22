import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config';
import type { AssetType, CloudinaryResourceType, UploadPurpose } from '../schema';

export const UPLOAD_FOLDER = 'bookaria';
export const SIGNATURE_TTL_SECONDS = 55 * 60;
export const UPLOAD_REQUEST_PER_MINUTE = 60;

export const TRANSFORM = {
    /** A square card for the library grid. */
    thumbnail: 'c_fill,w_320,h_320,q_auto,f_auto',
    /** A book cover: never wider than 800 px, proportions kept. */
    cover: 'c_limit,w_800,q_auto,f_auto',
    /** A round avatar is cut from a square, centred on the face when there is one. */
    avatar: 'c_fill,g_face,w_256,h_256,q_auto,f_auto',
} as const;

const ASSET_FORMATS: Record<AssetType, readonly string[]> = {
    MODEL: ['glb', 'gltf'],
    IMAGE: ['jpg', 'png', 'webp'],
    AUDIO: ['mp3', 'wav'],
    VIDEO: ['mp4'],
};
export function allowedFormats(
    purpose: UploadPurpose,
    assetType: AssetType | null,
): readonly string[] {
    if (purpose === 'PAGE_IMAGE') return ['jpg', 'png'];
    if (purpose === 'MARKER_MIND') return [];
    return assetType ? ASSET_FORMATS[assetType] : [];
}

export const normalizeFormat = (format: string) => {
    const f = format.toLowerCase();
    return f === 'jpeg' ? 'jpg' : f;
};

export interface StoredFile {
    publicId: string;
    /** Dung lượng thật do Cloudinary báo, dùng để kiểm tra hạn mức (không tin số client khai). */
    bytes: number;
    format: string;
    width: number | null;
    height: number | null;
    durationSec: number | null;
}

export interface SignedUpload {
    uploadUrl: string;
    fields: Record<string, string | number>;
    expiresAt: Date;
}

export interface MediaStorage {
    // Cấp phát một chữ ký tải lên cho Cloudinary, có hiệu lực trong SIGNATURE_TTL_SECONDS giây.
    signUpload(req: {
        publicId: string;
        resourceType: CloudinaryResourceType;
        allowedFormats: readonly string[];
        /** Thư mục hiển thị trong Media Library (chế độ dynamic folder: `public_id` không tạo thư mục). */
        assetFolder?: string;
        now?: Date;
    }): SignedUpload;

    // Lấy thông tin về một tệp đã lưu trong Cloudinary.
    inspect(resourceType: CloudinaryResourceType, publicId: string): Promise<StoredFile | null>;

    // Xóa một tệp đã lưu trong Cloudinary.
    destroy(resourceType: CloudinaryResourceType, publicId: string): Promise<void>;

    // Tạo URL để truy cập tệp đã lưu trong Cloudinary.
    deliveryUrl(req: {
        resourceType: CloudinaryResourceType;
        publicId: string;
        format?: string;
        transform?: string;
    }): string;
}

export interface CloudinaryAccount {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
}

// Chuyển đổi URL của Cloudinary thành thông tin tài khoản.
export function parseCloudinaryUrl(value: string): CloudinaryAccount {
    const url = new URL(value);
    if (url.protocol !== 'cloudinary:' || !url.username || !url.password || !url.hostname) {
        throw new Error(
            'CLOUDINARY_URL phải có dạng: cloudinary://<api_key>:<api_secret>@<cloud_name>',
        );
    }
    return {
        cloudName: url.hostname,
        apiKey: decodeURIComponent(url.username),
        apiSecret: decodeURIComponent(url.password),
    };
}

// Tạo chữ ký cho các tham số tải lên Cloudinary.
export function signParams(params: Record<string, string | number>, apiSecret: string): string {
    const text = Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== '')
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');

    return createHash('sha1')
        .update(text + apiSecret)
        .digest('hex');
}

const AdminResourceSchema = z.object({
    bytes: z.number().int().min(0),
    format: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    duration: z.number().optional(),
});

const REQUEST_TIMEOUT_MS = 15_000;

// Tạo một triển khai MediaStorage sử dụng Cloudinary.
export function createCloudinaryStorage(
    account: CloudinaryAccount,
    fetchImplementation: typeof fetch = fetch,
): MediaStorage {
    const api = `https://api.cloudinary.com/v1_1/${account.cloudName}`;
    const basicAuth = `Basic ${Buffer.from(`${account.apiKey}:${account.apiSecret}`).toString('base64')}`;

    const path = (publicId: string) => publicId.split('/').map(encodeURIComponent).join('/');

    return {
        signUpload({ publicId, resourceType, allowedFormats, assetFolder, now = new Date() }) {
            const timestamp = Math.floor(now.getTime() / 1000);
            const signed: Record<string, string | number> = {
                timestamp,
                public_id: publicId,
                // Không cho ghi đè.
                overwrite: 'false',
            };
            if (allowedFormats.length > 0) {
                signed.allowed_formats = allowedFormats.join(',');
            }
            if (assetFolder) signed.asset_folder = assetFolder;
            return {
                uploadUrl: `${api}/${resourceType}/upload`,
                fields: {
                    ...signed,
                    signature: signParams(signed, account.apiSecret),
                    api_key: account.apiKey,
                },
                expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000),
            };
        },
        async inspect(resourceType, publicId) {
            const metadataQuery = resourceType === 'video' ? '?media_metadata=true' : '';
            const res = await fetchImplementation(
                `${api}/resources/${resourceType}/upload/${path(publicId)}${metadataQuery}`,
                {
                    headers: {
                        Authorization: basicAuth,
                    },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                },
            );
            if (res.status === 404) return null;
            if (!res.ok) {
                throw new Error(
                    `Cloudinary đã trả về lỗi khi kiểm tra tệp ${publicId}: ${res.status} ${res.statusText}`,
                );
            }
            const parsed = AdminResourceSchema.safeParse(await res.json());
            if (!parsed.success) {
                throw new Error(`Cloudinary trả về dữ liệu không hiểu được cho tệp ${publicId}`);
            }
            const body = parsed.data;
            return {
                publicId,
                bytes: body.bytes,
                format: body.format ?? '',
                width: body.width ?? null,
                height: body.height ?? null,
                durationSec: body.duration ?? null,
            };
        },
        async destroy(resourceType, publicId) {
            const signed: Record<string, string | number> = {
                public_id: publicId,
                timestamp: Math.floor(Date.now() / 1000),
                invalidate: 'true', // xoá cả bản đã nằm trong CDN
            };
            const res = await fetchImplementation(`${api}/${resourceType}/destroy`, {
                method: 'POST',
                body: new URLSearchParams({
                    ...Object.fromEntries(Object.entries(signed).map(([k, v]) => [k, String(v)])),
                    signature: signParams(signed, account.apiSecret),
                    api_key: account.apiKey,
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!res.ok) {
                throw new Error(
                    `Cloudinary đã trả về lỗi khi xóa tệp ${publicId}: ${res.status} ${res.statusText}`,
                );
            }
        },
        deliveryUrl({ resourceType, publicId, format, transform }) {
            const base = `https://res.cloudinary.com/${account.cloudName}/${resourceType}/upload`;
            return `${base}/${transform ? `${transform}/` : ''}${path(publicId)}${format ? `.${format}` : ''}`;
        },
    };
}

let currentStorage: MediaStorage | undefined;

export function getMediaStorage(): MediaStorage | undefined {
    if (!currentStorage && env.CLOUDINARY_URL) {
        currentStorage = createCloudinaryStorage(parseCloudinaryUrl(env.CLOUDINARY_URL));
    }
    return currentStorage;
}
export function setMediaStorage(storage: MediaStorage | undefined): void {
    currentStorage = storage;
}
