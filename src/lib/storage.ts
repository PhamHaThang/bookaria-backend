import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import { env } from '../config';
import type { AssetType, StorageResourceType, UploadPurpose } from '../schema';
import { AppError } from '../utils/api-error';
import { renderImage } from './image-processing';
import { probeMedia } from './media-processing';

export const UPLOAD_FOLDER = 'bookaria';
export const SIGNATURE_TTL_SECONDS = 15 * 60;
export const UPLOAD_REQUEST_PER_MINUTE = 60;
export const TRANSFORM = {
    thumbnail: 'thumbnail',
    assetPreview: 'asset-preview',
    cover: 'cover',
    avatar: 'avatar',
} as const;
const formats: Record<AssetType, readonly string[]> = {
    MODEL: ['glb', 'gltf'],
    IMAGE: ['jpg', 'png', 'webp'],
    AUDIO: ['mp3', 'wav'],
    VIDEO: ['mp4'],
};
export function allowedFormats(purpose: UploadPurpose, type: AssetType | null): readonly string[] {
    if (purpose === 'PAGE_IMAGE') return ['jpg', 'png'];
    return type ? formats[type] : [];
}
export const normalizeFormat = (format: string) =>
    format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase();
export interface StoredFile {
    publicId: string;
    bytes: number;
    format: string;
    width: number | null;
    height: number | null;
    durationSec: number | null;
}
export interface SignedUpload {
    uploadUrl: string;
    method: 'PUT';
    objectKey: string;
    headers: Record<string, string>;
    expiresAt: Date;
}
type UploadRequest = {
    publicId: string;
    resourceType: StorageResourceType;
    allowedFormats: readonly string[];
    now?: Date;
    contentType?: string;
    format?: string;
    sizeBytes?: number;
};
type Delivery = {
    resourceType: StorageResourceType;
    publicId: string;
    format?: string;
    transform?: string;
};
export interface MediaStorage {
    signUpload(req: UploadRequest): SignedUpload | Promise<SignedUpload>;
    inspect(type: StorageResourceType, id: string): Promise<StoredFile | null>;
    destroy(type: StorageResourceType, id: string): Promise<void>;
    deliveryUrl(req: Delivery): string;
    prepareImage(publicId: string, transform: string, signal?: AbortSignal): Promise<string>;
}
export interface R2Account {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicUrl: string;
}
export function r2Account(): R2Account {
    if (
        !env.R2_ENDPOINT ||
        !env.R2_ACCESS_KEY_ID ||
        !env.R2_SECRET_ACCESS_KEY ||
        !env.R2_BUCKET ||
        !env.R2_PUBLIC_URL
    )
        throw new Error(
            'Cần cấu hình R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET và R2_PUBLIC_URL.',
        );
    const endpoint = new URL(env.R2_ENDPOINT),
        publicUrl = new URL(env.R2_PUBLIC_URL);
    for (const url of [endpoint, publicUrl]) {
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
            throw new Error('Địa chỉ R2 phải dùng HTTPS, không chứa credentials hoặc query.');
    }
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET))
        throw new Error('Tên bucket R2 không hợp lệ.');
    return {
        endpoint: endpoint.href.replace(/\/$/, ''),
        publicUrl: publicUrl.href.replace(/\/$/, ''),
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
    };
}
function path(key: string) {
    if (
        !key ||
        key.length > 1024 ||
        key.split('/').some((part) => !part || part === '.' || part === '..') ||
        Array.from(key).some((character) => character === '\\' || character.charCodeAt(0) < 32)
    )
        throw new Error('Object key không hợp lệ.');
    return key.split('/').map(encodeURIComponent).join('/');
}
export const IMAGE_DERIVATIVE_VERSION = 1;
export function derivativePrefix(key: string) {
    path(key);
    return `derived/v${IMAGE_DERIVATIVE_VERSION}/${createHash('sha256').update(key).digest('hex')}/`;
}
export function derivativeKey(key: string, transform: string) {
    if (!/^(?:thumbnail|asset-preview|avatar|cover|page-\d{1,4}-\d{1,4})$/.test(transform))
        throw new Error('Biến thể ảnh không hợp lệ.');
    return `${derivativePrefix(key)}${transform}.jpg`;
}
export function createR2Storage(account: R2Account, network: typeof fetch = fetch) {
    const signer = new AwsClient({
        accessKeyId: account.accessKeyId,
        secretAccessKey: account.secretAccessKey,
        service: 's3',
        region: 'auto',
    });
    const keyFor = (_type: StorageResourceType, id: string) => id;
    const publicUrl = (key: string) => `${account.publicUrl}/${path(key)}`;
    async function send(url: string, init: RequestInit = {}) {
        init.signal?.throwIfAborted();
        const signed = await signer.sign(url, {
            ...init,
            aws: { allHeaders: true },
        });
        const response = await network(signed, {
            redirect: 'error',
            signal: init.signal ?? AbortSignal.timeout(60_000),
        });
        if (!response.ok && response.status !== 404 && response.status !== 412) {
            await response.body?.cancel();
            throw new Error(`R2 trả HTTP ${response.status}.`);
        }
        return response;
    }
    // Immutable variants share work and skip repeat HEADs; cap retained entries per storage instance.
    const preparedImages = new Map<string, Promise<string>>();
    const request = (key: string, init: RequestInit = {}) =>
        send(`${account.endpoint}/${account.bucket}/${path(key)}`, init);
    async function head(key: string, signal?: AbortSignal) {
        // Compression can remove Content-Length; HEAD must describe the stored object bytes.
        const response = await request(key, {
            method: 'HEAD',
            headers: { 'Accept-Encoding': 'identity' },
            ...(signal && { signal }),
        });
        return response.status === 404 ? null : response.headers;
    }
    async function get(key: string, maximum: number, signal?: AbortSignal) {
        const response = await request(key, { ...(signal && { signal }) });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Không tìm thấy tệp R2.');
        }
        return readBytes(response, maximum, signal);
    }
    async function readBytes(response: Response, maximum: number, signal?: AbortSignal) {
        if (Number(response.headers.get('content-length')) > maximum) {
            await response.body?.cancel();
            throw new Error('Tệp vượt giới hạn xử lý.');
        }
        if (!response.body) throw new Error('Tệp rỗng.');
        const reader = response.body.getReader(),
            chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.length;
                if (size > maximum) throw new Error('Tệp vượt giới hạn xử lý.');
                chunks.push(part.value);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        signal?.throwIfAborted();
        return Buffer.concat(chunks);
    }
    async function put(
        key: string,
        bytes: Uint8Array,
        contentType: string,
        format: string,
        signal?: AbortSignal,
    ) {
        const response = await request(key, {
            method: 'PUT',
            body: Uint8Array.from(bytes),
            ...(signal && { signal }),
            headers: {
                'Content-Type': contentType,
                'If-None-Match': '*',
                'x-amz-meta-format': format,
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        });
        if (response.status === 412) throw new Error('Tệp R2 đã tồn tại; không ghi đè.');
        if (!response.ok) throw new Error('Không lưu được tệp R2.');
        await response.body?.cancel();
    }
    async function image(key: string, transform: string, signal: AbortSignal, missing = false) {
        const target = derivativeKey(key, transform);
        if (!missing && (await head(target, signal))) return get(target, 10 * 1024 * 1024, signal);
        const bytes = await renderImage(await get(key, 10 * 1024 * 1024, signal), transform);
        try {
            await put(target, bytes, 'image/jpeg', 'jpg', signal);
        } catch (error) {
            if (!(await head(target, signal))) throw error;
        }
        return bytes;
    }
    return {
        keyFor,
        publicUrl,
        head,
        get,
        put,
        image,
        async prepareImage(key: string, transform: string, signal = AbortSignal.timeout(30_000)) {
            signal.throwIfAborted();
            const target = derivativeKey(key, transform);
            let pending = preparedImages.get(target);
            if (!pending) {
                pending = (async () => {
                    if (!(await head(target, signal))) await image(key, transform, signal, true);
                    return publicUrl(target);
                })();
                preparedImages.set(target, pending);
                const oldest = preparedImages.keys().next().value;
                if (preparedImages.size > 256 && oldest !== undefined)
                    preparedImages.delete(oldest);
                const current = pending;
                void pending.catch(() => {
                    if (preparedImages.get(target) === current) preparedImages.delete(target);
                });
            }
            const url = await pending;
            signal.throwIfAborted();
            return url;
        },
        async listKeys(prefix: string, continuation: string | undefined, signal: AbortSignal) {
            if (!prefix.endsWith('/')) throw new Error('Cần prefix thư mục cụ thể.');
            path(prefix.slice(0, -1));
            const url = new URL(`${account.endpoint}/${account.bucket}`);
            url.search = new URLSearchParams({
                'list-type': '2',
                'max-keys': '100',
                prefix,
                'encoding-type': 'url',
                ...(continuation && { 'continuation-token': continuation }),
            }).toString();
            const response = await send(url.href, { signal });
            if (!response.ok) throw new Error('Không liệt kê được tệp R2.');
            const xml = (await readBytes(response, 256 * 1024, signal)).toString('utf8');
            if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true)
                throw new Error('Danh sách R2 không hợp lệ.');
            const parsed = new XMLParser({
                parseTagValue: false,
                removeNSPrefix: true,
                isArray: (name) => name === 'Contents',
            }).parse(xml);
            const result = z
                .object({
                    ListBucketResult: z.object({
                        IsTruncated: z.enum(['true', 'false']),
                        Contents: z.array(z.object({ Key: z.string().min(1) })).default([]),
                        NextContinuationToken: z.string().min(1).optional(),
                    }),
                })
                .parse(parsed).ListBucketResult;
            const keys = result.Contents.map(({ Key }) => decodeURIComponent(Key));
            for (const key of keys) {
                path(key);
                if (!key.startsWith(prefix)) throw new Error('R2 trả tệp ngoài prefix yêu cầu.');
            }
            const next = result.IsTruncated === 'true' ? result.NextContinuationToken : undefined;
            if (result.IsTruncated === 'true' && (!next || next === continuation))
                throw new Error('Phân trang R2 không hợp lệ.');
            return { keys, next };
        },
        async signUpload({
            publicId,
            resourceType,
            allowedFormats,
            now = new Date(),
            contentType = 'application/octet-stream',
            format,
            sizeBytes,
        }: UploadRequest): Promise<SignedUpload> {
            const objectKey = keyFor(resourceType, publicId);
            const headers: Record<string, string> = {
                'Content-Type': contentType,
                'If-None-Match': '*',
                'x-amz-meta-format': format ?? allowedFormats[0] ?? '',
                'Cache-Control': 'public, max-age=31536000, immutable',
            };
            const url = new URL(`${account.endpoint}/${account.bucket}/${path(objectKey)}`);
            url.searchParams.set('X-Amz-Expires', String(SIGNATURE_TTL_SECONDS));
            url.searchParams.set('X-Amz-Date', now.toISOString().replace(/[:-]|\.\d{3}/g, ''));
            const signed = await signer.sign(url.href, {
                method: 'PUT',
                headers: {
                    ...headers,
                    ...(sizeBytes ? { 'Content-Length': String(sizeBytes) } : {}),
                },
                aws: {
                    signQuery: true,
                    allHeaders: true,
                    datetime: now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
                },
            });
            return {
                uploadUrl: signed.url,
                method: 'PUT',
                objectKey: publicId,
                headers,
                expiresAt: new Date(now.getTime() + SIGNATURE_TTL_SECONDS * 1000),
            };
        },
        async inspect(type: StorageResourceType, publicId: string): Promise<StoredFile | null> {
            const key = keyFor(type, publicId),
                headers = await head(key);
            if (!headers) return null;
            const bytes = Number(headers.get('content-length'));
            if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 100 * 1024 * 1024)
                throw new Error('Dung lượng R2 không hợp lệ.');
            let format = normalizeFormat(headers.get('x-amz-meta-format') ?? '');
            let width: number | null = null,
                height: number | null = null,
                durationSec: number | null = null;
            if (type === 'image' && !['glb', 'gltf'].includes(format)) {
                const input = await get(key, 10 * 1024 * 1024);
                let metadata: Metadata;
                try {
                    metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
                } catch {
                    throw new AppError(
                        'FILE_TYPE_NOT_ALLOWED',
                        'Ảnh hỏng hoặc quá lớn khi giải nén. Hãy chọn ảnh JPG, PNG hoặc WebP hợp lệ.',
                    );
                }
                format = normalizeFormat(metadata.format ?? '');
                width = metadata.autoOrient.width ?? null;
                height = metadata.autoOrient.height ?? null;
            } else if (type === 'video') {
                const metadata = await probeMedia(await get(key, 100 * 1024 * 1024));
                format = metadata.format;
                width = metadata.width;
                height = metadata.height;
                durationSec = metadata.duration;
            }
            return { publicId, bytes, format, width, height, durationSec };
        },
        async destroy(type: StorageResourceType, publicId: string, signal?: AbortSignal) {
            const response = await request(keyFor(type, publicId), {
                method: 'DELETE',
                ...(signal && { signal }),
            });
            await response.body?.cancel();
        },
        deliveryUrl({ resourceType, publicId, transform }: Delivery) {
            const key = keyFor(resourceType, publicId);
            return publicUrl(transform ? derivativeKey(key, transform) : key);
        },
    };
}
let currentStorage: MediaStorage | undefined;
export function getMediaStorage(): MediaStorage | undefined {
    if (!currentStorage && env.R2_ENDPOINT) currentStorage = createR2Storage(r2Account());
    return currentStorage;
}
export function setMediaStorage(storage: MediaStorage | undefined) {
    currentStorage = storage;
}
