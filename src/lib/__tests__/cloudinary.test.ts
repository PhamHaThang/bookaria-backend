import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    createCloudinaryStorage,
    parseCloudinaryUrl,
    SIGNATURE_TTL_SECONDS,
    signParams,
} from '../cloudinary';

const account = { cloudName: 'demo', apiKey: '123456', apiSecret: 'sekret' };
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

/** `fetch` giả: ghi lại lời gọi và trả về phản hồi đã định sẵn. */
function fakeFetch(respond: () => Response) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return respond();
    }) as typeof fetch;
    return { impl, calls };
}
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

describe('parseCloudinaryUrl', () => {
    it('tách cloud name, api key, api secret (có ký tự đặc biệt đã mã hoá)', () => {
        expect(parseCloudinaryUrl('cloudinary://123:ab%2Fc%40d@my-cloud')).toEqual({
            cloudName: 'my-cloud',
            apiKey: '123',
            apiSecret: 'ab/c@d',
        });
    });

    it('URL sai dạng thì ném lỗi rõ ràng', () => {
        expect(() => parseCloudinaryUrl('https://x.test')).toThrow(/CLOUDINARY_URL/);
        expect(() => parseCloudinaryUrl('cloudinary://onlykey@cloud')).toThrow(/CLOUDINARY_URL/);
    });
});

describe('signParams', () => {
    it('sắp xếp khoá, nối bằng &, thêm secret rồi SHA-1', () => {
        const signature = signParams({ timestamp: 1700000000, public_id: 'a/b' }, 'sekret');
        expect(signature).toBe(sha1('public_id=a/b&timestamp=1700000000sekret'));
    });

    it('bỏ qua giá trị rỗng', () => {
        expect(signParams({ public_id: 'x', empty: '' }, 's')).toBe(sha1('public_id=xs'));
    });
});

describe('signUpload', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const storage = createCloudinaryStorage(account, fakeFetch(() => json({})).impl);

    it('địa chỉ upload theo loại tài nguyên, chữ ký khớp các trường gửi kèm', () => {
        const signed = storage.signUpload({
            publicId: 'bookaria/abc',
            resourceType: 'image',
            allowedFormats: ['jpg', 'png'],
            now,
        });
        const timestamp = Math.floor(now.getTime() / 1000);

        expect(signed.uploadUrl).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
        expect(signed.fields).toMatchObject({
            public_id: 'bookaria/abc',
            timestamp,
            allowed_formats: 'jpg,png',
            overwrite: 'false',
            api_key: '123456',
        });
        expect(signed.fields.signature).toBe(
            sha1(
                `allowed_formats=jpg,png&overwrite=false&public_id=bookaria/abc&timestamp=${timestamp}sekret`,
            ),
        );
    });

    it('có assetFolder thì ký và gửi kèm asset_folder; không có thì không gửi', () => {
        const withFolder = storage.signUpload({
            publicId: 'bookaria/u/a',
            resourceType: 'image',
            allowedFormats: [],
            assetFolder: 'bookaria/u',
            now,
        });
        const timestamp = Math.floor(now.getTime() / 1000);
        expect(withFolder.fields.asset_folder).toBe('bookaria/u');
        expect(withFolder.fields.signature).toBe(
            sha1(
                `asset_folder=bookaria/u&overwrite=false&public_id=bookaria/u/a&timestamp=${timestamp}sekret`,
            ),
        );

        const without = storage.signUpload({
            publicId: 'x',
            resourceType: 'image',
            allowedFormats: [],
            now,
        });
        expect(without.fields).not.toHaveProperty('asset_folder');
    });

    it('hạn dùng ngắn hơn giới hạn 1 giờ của Cloudinary', () => {
        const signed = storage.signUpload({
            publicId: 'x',
            resourceType: 'raw',
            allowedFormats: [],
            now,
        });
        expect(signed.expiresAt.getTime() - now.getTime()).toBe(SIGNATURE_TTL_SECONDS * 1000);
        expect(SIGNATURE_TTL_SECONDS).toBeLessThan(60 * 60);
    });

    it('không có allowed_formats khi danh sách rỗng, và không lộ api secret', () => {
        const signed = storage.signUpload({
            publicId: 'x',
            resourceType: 'raw',
            allowedFormats: [],
            now,
        });
        expect(signed.fields).not.toHaveProperty('allowed_formats');
        expect(JSON.stringify(signed)).not.toContain('sekret');
    });
});

describe('inspect', () => {
    it.each([
        { format: 'wav', width: 0, height: 0 },
        { format: 'mp4', width: 640, height: 480 },
    ])('requests full media metadata for $format to obtain duration', async (dimensions) => {
        const { impl, calls } = fakeFetch(() =>
            json({ bytes: 8044, duration: 0.5, ...dimensions }),
        );
        const storage = createCloudinaryStorage(account, impl);
        await expect(storage.inspect('video', 'bookaria/media')).resolves.toMatchObject({
            durationSec: 0.5,
            ...dimensions,
        });
        expect(calls[0]?.url).toBe(
            'https://api.cloudinary.com/v1_1/demo/resources/video/upload/bookaria/media?media_metadata=true',
        );
    });

    it('gọi đúng Admin API với xác thực Basic và trả dung lượng thật', async () => {
        const { impl, calls } = fakeFetch(() =>
            json({ bytes: 1234, format: 'png', width: 640, height: 480 }),
        );
        const storage = createCloudinaryStorage(account, impl);

        const file = await storage.inspect('image', 'bookaria/a b');

        expect(calls[0]?.url).toBe(
            'https://api.cloudinary.com/v1_1/demo/resources/image/upload/bookaria/a%20b',
        );
        const headers = calls[0]?.init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(
            `Basic ${Buffer.from('123456:sekret').toString('base64')}`,
        );
        expect(file).toEqual({
            publicId: 'bookaria/a b',
            bytes: 1234,
            format: 'png',
            width: 640,
            height: 480,
            durationSec: null,
        });
    });

    it('404 thì trả null (file chưa được upload)', async () => {
        const storage = createCloudinaryStorage(
            account,
            fakeFetch(() => json({ error: { message: 'not found' } }, 404)).impl,
        );
        await expect(storage.inspect('image', 'bookaria/none')).resolves.toBeNull();
    });

    it('lỗi khác (500) thì ném lỗi, không nhầm với "chưa upload"', async () => {
        const storage = createCloudinaryStorage(account, fakeFetch(() => json({}, 500)).impl);
        await expect(storage.inspect('image', 'bookaria/a')).rejects.toThrow(/500/);
    });

    it('dữ liệu trả về không hiểu được thì ném lỗi có ngữ cảnh', async () => {
        const storage = createCloudinaryStorage(
            account,
            fakeFetch(() => json({ unexpected: true })).impl,
        );
        await expect(storage.inspect('image', 'bookaria/a')).rejects.toThrow(/bookaria\/a/);
    });
});

describe('destroy', () => {
    it('POST tới đúng địa chỉ với chữ ký hợp lệ', async () => {
        const { impl, calls } = fakeFetch(() => json({ result: 'ok' }));
        const storage = createCloudinaryStorage(account, impl);

        await storage.destroy('video', 'bookaria/a');

        expect(calls[0]?.url).toBe('https://api.cloudinary.com/v1_1/demo/video/destroy');
        expect(calls[0]?.init?.method).toBe('POST');
        const body = calls[0]?.init?.body as URLSearchParams;
        expect(body.get('public_id')).toBe('bookaria/a');
        expect(body.get('api_key')).toBe('123456');
        expect(body.get('invalidate')).toBe('true');
        const timestamp = body.get('timestamp');
        expect(body.get('signature')).toBe(
            sha1(`invalidate=true&public_id=bookaria/a&timestamp=${timestamp}sekret`),
        );
    });

    it('Cloudinary báo lỗi thì ném lỗi', async () => {
        const storage = createCloudinaryStorage(account, fakeFetch(() => json({}, 401)).impl);
        await expect(storage.destroy('image', 'bookaria/a')).rejects.toThrow(/401/);
    });
});

describe('deliveryUrl', () => {
    const storage = createCloudinaryStorage(account, fakeFetch(() => json({})).impl);

    it('dựng URL có biến đổi và đuôi file', () => {
        expect(
            storage.deliveryUrl({
                resourceType: 'image',
                publicId: 'bookaria/a',
                format: 'jpg',
                transform: 'c_fill,w_320,h_320',
            }),
        ).toBe('https://res.cloudinary.com/demo/image/upload/c_fill,w_320,h_320/bookaria/a.jpg');
    });

    it('không có biến đổi và đuôi thì chỉ có public_id', () => {
        expect(storage.deliveryUrl({ resourceType: 'raw', publicId: 'bookaria/a' })).toBe(
            'https://res.cloudinary.com/demo/raw/upload/bookaria/a',
        );
    });
});
