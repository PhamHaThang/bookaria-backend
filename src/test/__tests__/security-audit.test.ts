import { createHash, randomUUID } from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import { encode } from '@msgpack/msgpack';
import express from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { corsOrigins } from '../../config';
import { pool } from '../../db';
import {
    createR2Storage,
    getMediaStorage,
    type Mail,
    type MediaStorage,
    type StoredFile,
    setGoogleVerifier,
    setMailer,
    setMediaStorage,
} from '../../lib';
import { renderImage } from '../../lib/image-processing';
import { probeMedia } from '../../lib/media-processing';
import { REFRESH_TOKEN_COOKIE_NAME } from '../../modules/auth/auth.constants';
import { validateCandidate } from '../../modules/interaction-ai/generation';
import { ModelStream } from '../../modules/model-generation/runpod';
import { HttpUrlSchema, SceneSchema } from '../../schema';
import { decodeSingleMind } from '../../worker/publish/mind';
import { optimizeModel } from '../../worker/optimize/model';
import { renderPrintPdf } from '../../worker/print/render';
import { readFont, sampleImages, sampleSource } from '../../worker/print/__tests__/fixtures';
import { verifyFixtureEmail } from '../verified-author';

const dbSuite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const PASSWORD = 'Matkhau-123';

const uniqueEmail = (prefix = 'sec') =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function cookieOf(res: request.Response): string | undefined {
    const header = res.headers['set-cookie'] as string[] | string | undefined;
    const list = Array.isArray(header) ? header : header ? [header] : [];
    const entry = list.find((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`));
    return entry ? entry.split(';')[0]?.split('=')[1] : undefined;
}

describe('Security Verification — Worker, Schemas & Storage Guards (Offline)', () => {
    it('SEC-BE-10: R2 storage path() blocks traversal and control characters in objectKey', () => {
        const r2 = createR2Storage({
            endpoint: 'https://account.r2.cloudflarestorage.com',
            accessKeyId: 'test-access-key',
            secretAccessKey: 'test-secret-key',
            bucket: 'bookaria-test',
            publicUrl: 'https://cdn.example.com',
        });
        for (const badKey of ['../secret.png', 'bookaria/../admin', 'bookaria\\file', 'a\u0000b']) {
            expect(() => r2.deliveryUrl({ resourceType: 'raw', publicId: badKey })).toThrow(
                'Object key không hợp lệ.',
            );
        }
    });

    it('SEC-STU-02: renderImage rejects non-image / SVG / malformed payload bytes', async () => {
        const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
        await expect(renderImage(svgBytes, 'avatar')).rejects.toMatchObject({
            code: 'FILE_TYPE_NOT_ALLOWED',
        });
        await expect(renderImage(Buffer.from('not-an-image'), 'cover')).rejects.toMatchObject({
            code: 'FILE_TYPE_NOT_ALLOWED',
        });
    });

    it('SEC-WK-01: optimizeModel blocks external SSRF/LFI URIs, huge declared buffers, and spoofed texture MIME', async () => {
        const signal = new AbortController().signal;

        // 1. glTF JSON with external metadata / file URI
        for (const uri of [
            'http://169.254.169.254/latest/meta-data/',
            'file:///etc/passwd',
        ]) {
            const gltfJson = Buffer.from(
                JSON.stringify({
                    asset: { version: '2.0' },
                    buffers: [{ uri, byteLength: 12 }],
                    scenes: [{ nodes: [] }],
                }),
            );
            await expect(optimizeModel(gltfJson, signal)).rejects.toMatchObject({
                code: 'EXTERNAL_RESOURCE',
            });
        }

        // 2. glTF declaring buffer > 128 MiB
        const complexGltf = Buffer.from(
            JSON.stringify({
                asset: { version: '2.0' },
                buffers: [{ byteLength: 200 * 1024 * 1024 }],
                scenes: [{ nodes: [] }],
            }),
        );
        await expect(optimizeModel(complexGltf, signal)).rejects.toMatchObject({
            code: 'MODEL_COMPLEX',
        });

        // 3. GLB embedding text bytes declared as image/png texture
        const doc = new Document();
        const buffer = doc.createBuffer();
        const pos = doc
            .createAccessor()
            .setType('VEC3')
            .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
            .setBuffer(buffer);
        const tex = doc
            .createTexture('FakeTex')
            .setMimeType('image/png')
            .setImage(Buffer.from('plain text disguised as png'));
        const mat = doc.createMaterial().setBaseColorTexture(tex);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setMaterial(mat);
        doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
        const glb = await new NodeIO().writeBinary(doc);
        await expect(optimizeModel(glb, signal)).rejects.toMatchObject({
            code: 'INVALID_TEXTURE',
        });
    });

    it('SEC-WK-02: decodeSingleMind rejects empty, oversized (>5 MiB), and invalid-dimension .mind data', () => {
        expect(() => decodeSingleMind(new Uint8Array())).toThrow();
        expect(() => decodeSingleMind(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow();

        const hugeDims = encode({
            v: 2,
            dataList: [
                {
                    targetImage: { width: 99999, height: 1024 },
                    matchingData: [{}],
                    trackingData: [{}],
                },
            ],
        });
        expect(() => decodeSingleMind(hugeDims)).toThrow();
        expect(() => decodeSingleMind(Buffer.from('not-msgpack-mind'))).toThrow();
    });

    it('SEC-WK-03: probeMedia rejects fake video payloads and renderPrintPdf enforces glyph & QR limits', async () => {
        await expect(probeMedia(Buffer.from('#EXTM3U\nhttp://127.0.0.1/secret'))).rejects.toMatchObject({
            code: 'FILE_TYPE_NOT_ALLOWED',
        });

        const base = {
            source: sampleSource(),
            request: { kind: 'PRINT' as const, qrMode: 'COVER_ONLY' as const, bleedMm: 3 as const },
            versionNo: 1,
            url: 'https://viewer.example.com/b/demo',
            fontBytes: await readFont(),
            signal: new AbortController().signal,
            download: await sampleImages(),
        };
        // Emoji outside Noto Sans font
        await expect(
            renderPrintPdf({
                ...base,
                source: { ...base.source, title: 'Sách 🚀' },
                request: { kind: 'MARKER_SHEET', qrMode: 'COVER_ONLY', bleedMm: 3 },
            }),
        ).rejects.toMatchObject({ code: 'PRINT_FONT_GLYPH' });

        // Extremely long URL exceeding 30mm QR density
        await expect(
            renderPrintPdf({
                ...base,
                url: `https://viewer.example.com/b/${'a'.repeat(800)}`,
            }),
        ).rejects.toMatchObject({ code: 'PRINT_QR_DENSITY' });
    });

    it('SEC-WK-04: RunPod ModelStream enforces moderation, SHA-256, glTF header, and blocks external URIs', () => {
        const validBytes = (() => {
            const json = Buffer.from(
                JSON.stringify({
                    meshes: [{}],
                    textures: [{}],
                    images: [{ uri: 'data:image/png;base64,AA==' }],
                    buffers: [],
                }),
            );
            const paddedLen = Math.ceil(json.length / 4) * 4;
            const jsonChunk = Buffer.alloc(paddedLen, 0x20);
            json.copy(jsonChunk);
            const out = Buffer.alloc(20 + paddedLen);
            out.write('glTF', 0, 'ascii');
            out.writeUInt32LE(2, 4);
            out.writeUInt32LE(out.length, 8);
            out.writeUInt32LE(paddedLen, 12);
            out.writeUInt32LE(0x4e4f534a, 16);
            jsonChunk.copy(out, 20);
            return out;
        })();

        // 1. Missing moderation verdict fails
        const unmoderated = new ModelStream();
        unmoderated.add({
            type: 'file_meta',
            size: validBytes.length,
            chunks: 1,
            sha256: createHash('sha256').update(validBytes).digest('hex'),
        });
        unmoderated.add({ type: 'file_chunk', index: 0, data: validBytes.toString('base64') });
        unmoderated.add({ type: 'done' });
        expect(() => unmoderated.finish()).toThrow();

        // 2. NSFW moderation verdict fails
        const nsfw = new ModelStream();
        expect(() =>
            nsfw.add({
                type: 'result',
                action: 'pipeline',
                data: {
                    moderation: { ok: true, is_nsfw: true },
                    texture_moderation: { ok: true, is_nsfw: false },
                },
            }),
        ).toThrow();

        // 3. External URI in GLB JSON fails
        const externalJson = Buffer.from(
            JSON.stringify({
                meshes: [{}],
                textures: [{}],
                images: [{ uri: 'http://127.0.0.1/secret.png' }],
                buffers: [],
            }),
        );
        const padExt = Math.ceil(externalJson.length / 4) * 4;
        const extBuf = Buffer.alloc(20 + padExt, 0x20);
        extBuf.write('glTF', 0, 'ascii');
        extBuf.writeUInt32LE(2, 4);
        extBuf.writeUInt32LE(extBuf.length, 8);
        extBuf.writeUInt32LE(padExt, 12);
        extBuf.writeUInt32LE(0x4e4f534a, 16);
        externalJson.copy(extBuf, 20);

        const extStream = new ModelStream();
        extStream.add({
            type: 'result',
            action: 'pipeline',
            data: {
                moderation: { ok: true, is_nsfw: false },
                texture_moderation: { ok: true, is_nsfw: false },
            },
        });
        extStream.add({
            type: 'file_meta',
            size: extBuf.length,
            chunks: 1,
            sha256: createHash('sha256').update(extBuf).digest('hex'),
        });
        extStream.add({ type: 'file_chunk', index: 0, data: extBuf.toString('base64') });
        extStream.add({ type: 'done' });
        expect(() => extStream.finish()).toThrow();
    });

    it('SEC-WK-05: Boki AI validateCandidate rejects locked-object edits, scope bypass, unknown assets, and non-HTTP URLs', () => {
        const scene = SceneSchema.parse({
            schemaVersion: 1,
            objects: [
                { id: 'obj1', type: 'text', text: 'Khóa', locked: true, transform: {} },
                { id: 'obj2', type: 'text', text: 'Mở', locked: false, transform: {} },
            ],
        });
        const baseContext = {
            scene,
            assets: [],
            editor: {
                variables: [],
                pages: [{ id: '11111111-1111-4111-8111-111111111111', title: 'P1' }],
                hasMarker: false,
            },
        };

        // 1. Modifying locked object rejected
        const lockedEdit = JSON.stringify({
            status: 'edit_plan',
            rules: [],
            objectEdits: [{ objectId: 'obj1', text: 'Bị sửa' }],
        });
        expect(validateCandidate(lockedEdit, baseContext).ok).toBe(false);

        // 2. Scope bypass when selectedObjectId = obj2
        const scopeEscape = JSON.stringify({
            status: 'edit_plan',
            rules: [],
            objectAdds: [{ localId: 'n1', type: 'text', text: 'Thêm ngoài phạm vi' }],
        });
        expect(
            validateCandidate(scopeEscape, {
                ...baseContext,
                editor: { ...baseContext.editor, selectedObjectId: 'obj2' },
            }).ok,
        ).toBe(false);

        // 3. javascript: openUrl rejected
        const jsUrl = JSON.stringify({
            status: 'edit_plan',
            rules: [
                {
                    name: 'Link',
                    trigger: { type: 'onTap', objectId: 'obj2' },
                    actions: [{ type: 'openUrl', url: 'javascript:void(0)' }],
                },
            ],
        });
        expect(validateCandidate(jsUrl, baseContext).ok).toBe(false);

        // 4. Unknown assetId not owned by author rejected
        const foreignAsset = JSON.stringify({
            status: 'edit_plan',
            rules: [],
            objectAdds: [
                {
                    localId: 'm1',
                    type: 'model',
                    assetId: '99999999-9999-4999-8999-999999999999',
                },
            ],
        });
        expect(validateCandidate(foreignAsset, baseContext).ok).toBe(false);
    });

    it('SEC-VW-02a: HttpUrlSchema rejects javascript:, data:, and ftp: URLs', () => {
        expect(HttpUrlSchema.safeParse('javascript:void(0)').success).toBe(false);
        expect(HttpUrlSchema.safeParse('data:text/html,hi').success).toBe(false);
        expect(HttpUrlSchema.safeParse('ftp://example.com/a').success).toBe(false);
        expect(HttpUrlSchema.safeParse('https://example.com/safe').success).toBe(true);
    });

    it('SEC-VW-02b [GAP CHECK]: HttpUrlSchema should reject embedded username@password credentials in openUrl/buttonUrl', () => {
        expect(HttpUrlSchema.safeParse('https://trusted.com@evil.example/login').success).toBe(false);
    });
});

dbSuite('Security Verification — Backend API, Auth, RBAC, IDOR & Rate Limit (Local DB)', () => {
    const app = createApp({ rateLimit: false });
    const files = new Map<string, StoredFile>();
    const sentMails: Mail[] = [];
    let previousStorage: MediaStorage | undefined;

    const fakeStorage: MediaStorage = {
        async prepareImage(publicId, transform) {
            return this.deliveryUrl({ resourceType: 'image', publicId, transform });
        },
        signUpload: ({ publicId, resourceType, contentType, format }) => ({
            uploadUrl: `https://fake.r2.cloudflarestorage.com/${publicId}`,
            method: 'PUT',
            objectKey: publicId,
            headers: {
                'Content-Type': contentType ?? 'application/octet-stream',
                'If-None-Match': '*',
                'x-amz-meta-format': format ?? '',
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
            expiresAt: new Date(Date.now() + 15 * 60_000),
        }),
        inspect: async (_type, publicId) => files.get(publicId) ?? null,
        destroy: async (_type, publicId) => {
            files.delete(publicId);
        },
        deliveryUrl: ({ resourceType, publicId, transform, format }) =>
            `https://cdn.example.com/${resourceType}/${transform ? `${transform}/` : ''}${publicId}${
                format ? `.${format}` : ''
            }`,
    };

    beforeAll(() => {
        previousStorage = getMediaStorage();
        setMediaStorage(fakeStorage);
        setMailer({
            async send(mail) {
                sentMails.push(mail);
            },
        });
    });

    afterAll(() => {
        setMediaStorage(previousStorage);
        setGoogleVerifier(undefined);
    });

    afterEach(() => {
        files.clear();
        setGoogleVerifier(undefined);
    });

    async function createAuthor(prefix = 'author', verified = true) {
        const email = uniqueEmail(prefix);
        const res = await request(app)
            .post('/api/v1/auth/register')
            .send({ email, password: PASSWORD, displayName: prefix });
        expect(res.status).toBe(201);
        const userId = res.body.data.user.id as string;
        if (verified) await verifyFixtureEmail(userId);
        return {
            email,
            userId,
            token: res.body.data.accessToken as string,
            cookie: cookieOf(res) as string,
        };
    }

    async function createAdmin(prefix = 'admin') {
        const user = await createAuthor(prefix, true);
        await pool.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [user.userId]);
        const login = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: user.email, password: PASSWORD });
        return {
            ...user,
            token: login.body.data.accessToken as string,
            cookie: cookieOf(login) as string,
        };
    }

    async function seedBookWithPageAndAsset(ownerId: string) {
        const asset = await pool.query<{ id: string }>(
            `INSERT INTO assets (owner_id, type, name, original_public_id, resource_type, format, size_bytes, status, meta)
             VALUES ($1, 'IMAGE', 'Ảnh riêng', $2, 'image', 'png', 1024, 'READY', '{}') RETURNING id`,
            [ownerId, `bookaria/${ownerId}/${randomUUID()}`],
        );
        const assetId = asset.rows[0]!.id;
        const book = await pool.query<{ id: string }>(
            `INSERT INTO books (owner_id, title, visibility) VALUES ($1, 'Sách bí mật', 'PRIVATE') RETURNING id`,
            [ownerId],
        );
        const bookId = book.rows[0]!.id;
        const page = await pool.query<{ id: string }>(
            `INSERT INTO pages (book_id, order_index, image_asset_id, marker_mode) VALUES ($1, 0, $2, 'NONE') RETURNING id`,
            [bookId, assetId],
        );
        const job = await pool.query<{ id: string }>(
            `INSERT INTO jobs (type, ref_type, ref_id, created_by) VALUES ('OPTIMIZE_ASSET', 'ASSET', $1, $2) RETURNING id`,
            [assetId, ownerId],
        );
        return {
            assetId,
            bookId,
            pageId: page.rows[0]!.id,
            jobId: job.rows[0]!.id,
        };
    }

    it('SEC-BE-01: Author B cannot read/modify/delete/preview/export Author A PRIVATE book, page, or job (404)', async () => {
        const a = await createAuthor('ownera');
        const b = await createAuthor('attackerb');
        const owned = await seedBookWithPageAndAsset(a.userId);

        const calls = [
            request(app).get(`/api/v1/books/${owned.bookId}`).set(bearer(b.token)),
            request(app)
                .patch(`/api/v1/books/${owned.bookId}`)
                .set(bearer(b.token))
                .send({ title: 'Bị sửa' }),
            request(app).delete(`/api/v1/books/${owned.bookId}`).set(bearer(b.token)),
            request(app).get(`/api/v1/books/${owned.bookId}/draft`).set(bearer(b.token)),
            request(app)
                .put(`/api/v1/books/${owned.bookId}/draft`)
                .set(bearer(b.token))
                .send({ revision: '0'.repeat(64), order: [], changes: [] }),
            request(app).get(`/api/v1/pages/${owned.pageId}`).set(bearer(b.token)),
            request(app)
                .post(`/api/v1/books/${owned.bookId}/previews`)
                .set(bearer(b.token))
                .send({ scope: 'BOOK' }),
            request(app).get(`/api/v1/books/${owned.bookId}/print-layout`).set(bearer(b.token)),
            request(app)
                .post(`/api/v1/books/${owned.bookId}/print-pdf`)
                .set(bearer(b.token))
                .send({ kind: 'MARKER_SHEET' }),
            request(app).get(`/api/v1/books/${owned.bookId}/stats`).set(bearer(b.token)),
            request(app).get(`/api/v1/jobs/${owned.jobId}`).set(bearer(b.token)),
        ];

        for (const call of calls) {
            const res = await call;
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe('NOT_FOUND');
        }
    });

    it('SEC-BE-02: Author B cannot reference Author A private assetId, avatarAssetId, or markerMindPublicId', async () => {
        const a = await createAuthor('assetA');
        const b = await createAuthor('assetB');
        const ownedA = await seedBookWithPageAndAsset(a.userId);
        const ownedB = await seedBookWithPageAndAsset(b.userId);

        // 1. Cover asset IDOR
        const badCover = await request(app)
            .patch(`/api/v1/books/${ownedB.bookId}`)
            .set(bearer(b.token))
            .send({ coverAssetId: ownedA.assetId });
        expect(badCover.status).toBe(400);

        // 2. Avatar asset IDOR
        const badAvatar = await request(app)
            .patch('/api/v1/me')
            .set(bearer(b.token))
            .send({ avatarAssetId: ownedA.assetId });
        expect(badAvatar.status).toBe(400);

        // 3. Draft scene & markerMindPublicId cross-user prefix IDOR
        const foreignMindKey = `bookaria/${a.userId}/${randomUUID()}.mind`;
        files.set(foreignMindKey, {
            publicId: foreignMindKey,
            bytes: 1024,
            format: '',
            width: null,
            height: null,
            durationSec: null,
        });
        const badMind = await request(app)
            .put(`/api/v1/books/${ownedB.bookId}/draft`)
            .set(bearer(b.token))
            .send({
                revision: 0,
                order: [ownedB.pageId],
                changes: [{ id: ownedB.pageId, markerMindPublicId: foreignMindKey }],
            });
        expect(badMind.status).toBe(400);
    });

    it('SEC-BE-03: AUTHOR blocked from all /admin/* endpoints and cannot escalate role via /register or /me', async () => {
        const author = await createAuthor('norm');
        const admin = await createAdmin('root');
        const owned = await seedBookWithPageAndAsset(author.userId);

        // 1. Mass assignment check on register
        const regAdmin = await request(app)
            .post('/api/v1/auth/register')
            .send({
                email: uniqueEmail('mass'),
                password: PASSWORD,
                displayName: 'Mass',
                role: 'ADMIN',
            });
        expect(regAdmin.status).toBe(201);
        expect(regAdmin.body.data.user.role).toBe('AUTHOR');

        // 2. Author hitting /admin/*
        const adminPaths = [
            request(app).get('/api/v1/admin/users').set(bearer(author.token)),
            request(app)
                .patch(`/api/v1/admin/users/${author.userId}`)
                .set(bearer(author.token))
                .send({ role: 'ADMIN', reason: 'test' }),
            request(app)
                .post(`/api/v1/admin/books/${owned.bookId}/takedown`)
                .set(bearer(author.token))
                .send({ reason: 'test' }),
            request(app)
                .post(`/api/v1/admin/jobs/${owned.jobId}/retry`)
                .set(bearer(author.token)),
            request(app).get('/api/v1/admin/audit-logs').set(bearer(author.token)),
            request(app)
                .post('/api/v1/admin/bookaria-markers/upload-signature')
                .set(bearer(author.token))
                .send({ imageFormat: 'png', imageBytes: 100, mindBytes: 100 }),
        ];
        for (const call of adminPaths) {
            const res = await call;
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
        }

        // 3. Admin self-lock rejected
        const selfLock = await request(app)
            .patch(`/api/v1/admin/users/${admin.userId}`)
            .set(bearer(admin.token))
            .send({ status: 'LOCKED', reason: 'self' });
        expect(selfLock.status).toBe(422);
        expect(selfLock.body.error.code).toBe('SELF_ACTION');
    });

    it('SEC-BE-04: Taken-down book cannot be reopened or republished by Author and returns 410 publicly', async () => {
        const author = await createAuthor('tdauthor');
        const admin = await createAdmin('tdadmin');
        const owned = await seedBookWithPageAndAsset(author.userId);
        const slug = `td-book-${Date.now().toString(36)}`;
        const versionId = randomUUID();
        await pool.query(
            `INSERT INTO book_versions (id, book_id, version_no, schema_version, manifest_public_id, mind_groups, page_count, ar_page_count, total_size_bytes)
             VALUES ($1, $2, 1, 1, 'bookaria/m.json', '[]'::jsonb, 1, 0, 100)`,
            [versionId, owned.bookId],
        );
        await pool.query(
            `UPDATE books SET status='PUBLISHED', visibility='PUBLIC', slug=$2, current_version_id=$3 WHERE id=$1`,
            [owned.bookId, slug, versionId],
        );

        const td = await request(app)
            .post(`/api/v1/admin/books/${owned.bookId}/takedown`)
            .set(bearer(admin.token))
            .send({ reason: 'Vi phạm bản quyền' });
        expect(td.status).toBe(200);

        const reopen = await request(app)
            .patch(`/api/v1/books/${owned.bookId}/visibility`)
            .set(bearer(author.token))
            .send({ visibility: 'PUBLIC' });
        expect(reopen.status).toBe(403);
        expect(reopen.body.error.code).toBe('BOOK_TAKEN_DOWN');

        const republish = await request(app)
            .post(`/api/v1/books/${owned.bookId}/publish`)
            .set(bearer(author.token))
            .send({ visibility: 'PUBLIC', acceptWarnings: true });
        expect(republish.status).toBe(403);
        expect(republish.body.error.code).toBe('BOOK_TAKEN_DOWN');

        const pub = await request(app).get(`/api/v1/public/books/${slug}`);
        expect(pub.status).toBe(410);
        expect(pub.body.error.code).toBe('BOOK_UNAVAILABLE');
    });

    it('SEC-BE-05 & SEC-BE-06: Unverified email blocked, Admin lock returns 423 immediately, Google link revokes unverified password', async () => {
        const unverified = await createAuthor('unv', false);
        const blocked = await request(app).get('/api/v1/books').set(bearer(unverified.token));
        expect(blocked.status).toBe(403);
        expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

        // Google OAuth linking to an unverified password account clears password & revokes old session
        setGoogleVerifier({
            async verify() {
                return {
                    sub: `g-${randomUUID()}`,
                    email: unverified.email,
                    emailVerified: true,
                    name: 'Google Owner',
                };
            },
        });
        const gLogin = await request(app).post('/api/v1/auth/google').send({ idToken: 'valid-id' });
        expect(gLogin.status).toBe(200);

        const oldSession = await request(app).get('/api/v1/me').set(bearer(unverified.token));
        expect(oldSession.status).toBe(401);
        const oldPasswordLogin = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: unverified.email, password: PASSWORD });
        expect(oldPasswordLogin.status).toBe(401);

        // Admin locks active user -> 423 on both /me and /auth/refresh
        const admin = await createAdmin('lockadmin');
        const lockRes = await request(app)
            .patch(`/api/v1/admin/users/${unverified.userId}`)
            .set(bearer(admin.token))
            .send({ status: 'LOCKED', reason: 'Vi phạm' });
        expect(lockRes.status).toBe(200);

        expect((await request(app).get('/api/v1/me').set(bearer(gLogin.body.data.accessToken))).status).toBe(423);
        const refreshLocked = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Origin', corsOrigins[0] ?? 'http://localhost:5173')
            .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${cookieOf(gLogin)}`);
        expect([401, 423]).toContain(refreshLocked.status);
    });

    it('SEC-BE-07a: Untrusted Origin rejected (403) and Refresh Token reuse outside grace revokes session', async () => {
        const u = await createAuthor('rot');
        const badOrigin = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Origin', 'https://untrusted.example')
            .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${u.cookie}`);
        expect(badOrigin.status).toBe(403);

        const rotated = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Origin', corsOrigins[0] ?? 'http://localhost:5173')
            .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${u.cookie}`);
        expect(rotated.status).toBe(200);
        const r2 = cookieOf(rotated) as string;

        await pool.query(
            `UPDATE auth_sessions SET last_used_at = now() - interval '2 minutes' WHERE user_id = $1`,
            [u.userId],
        );
        const reuse = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Origin', corsOrigins[0] ?? 'http://localhost:5173')
            .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${u.cookie}`);
        expect(reuse.status).toBe(401);

        const r2AfterRevoke = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Origin', corsOrigins[0] ?? 'http://localhost:5173')
            .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${r2}`);
        expect(r2AfterRevoke.status).toBe(401);
    });

    it('SEC-BE-07b [GAP CHECK]: requireTrustedOrigin should fail closed (403) when Origin header is omitted on cookie-authenticated /auth/refresh', async () => {
        const u = await createAuthor('no-origin');
        const missingOrigin = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${u.cookie}`);
        expect(missingOrigin.status).toBe(403);
    });

    it('SEC-BE-08b [GAP CHECK]: forgotLimit should isolate per IP|email so IP1 quota exhaustion does not lock out IP2 legitimate reset', async () => {
        const victim = await createAuthor('victim');
        const limitedApp = createApp({ rateLimit: true });
        // supertest connects via socket, so req.ip is always '::ffff:127.0.0.1' unless trust proxy is set.
        // Enable trust proxy so X-Forwarded-For is respected in the test.
        limitedApp.set('trust proxy', 1);

        // /forgot-password has limit=3 keyed by `forgot:${ip}|email:${email}`.
        // 3 requests from attacker IP exhaust only the attacker's key.
        for (let i = 0; i < 3; i++) {
            const r = await request(limitedApp)
                .post('/api/v1/auth/forgot-password')
                .set('X-Forwarded-For', '10.0.0.10')
                .send({ email: victim.email });
            expect(r.status).toBe(200);
        }
        // Legitimate user from another IP should NOT be blocked by attacker's IP quota
        const fromCleanIp = await request(limitedApp)
            .post('/api/v1/auth/forgot-password')
            .set('X-Forwarded-For', '198.51.100.77')
            .send({ email: victim.email });
        expect(fromCleanIp.status).toBe(200);
    });

    it('SEC-BE-09 & SEC-BE-10: SQL injection attempts in q/sort & Path traversal in upload fileName are neutralized', async () => {
        const a = await createAuthor('sqli');
        const owned = await seedBookWithPageAndAsset(a.userId);

        const badSort = await request(app)
            .get('/api/v1/books?sort=password_hash')
            .set(bearer(a.token));
        expect(badSort.status).toBe(400);

        const wildcardSearch = await request(app)
            .get(`/api/v1/books?q=${encodeURIComponent("%_' OR 1=1--")}`)
            .set(bearer(a.token));
        expect(wildcardSearch.status).toBe(200);
        expect(wildcardSearch.body.data).toHaveLength(0);

        const badUuid = await request(app)
            .get('/api/v1/books/not-a-uuid')
            .set(bearer(a.token));
        expect([400, 404]).toContain(badUuid.status);

        const traversalSig = await request(app)
            .post('/api/v1/assets/upload-signature')
            .set(bearer(a.token))
            .send({
                purpose: 'ASSET',
                fileName: '../../etc/passwd.png',
                mimeType: 'image/png',
                sizeBytes: 1200,
            });
        expect(traversalSig.status).toBe(200);
        expect(traversalSig.body.data.objectKey).toMatch(
            new RegExp(`^bookaria/${a.userId}/[0-9a-f-]{36}$`),
        );
        expect(owned.bookId).toBeTruthy();
    });

    it('SEC-STU-01 [GAP CHECK]: POST /assets/upload-signature should reject .glb upload declaring text/html MIME type', async () => {
        const a = await createAuthor('glbmime');
        const sig = await request(app)
            .post('/api/v1/assets/upload-signature')
            .set(bearer(a.token))
            .send({
                purpose: 'ASSET',
                fileName: 'malicious.glb',
                mimeType: 'text/html',
                sizeBytes: 1024,
            });
        expect(sig.status).toBe(422);
    });

    it('SEC-STU-03 [GAP CHECK]: POST /assets/upload-signature should rate-limit repeated successful MARKER_MIND requests', async () => {
        const limitedApp = createApp({ rateLimit: true });
        const a = await createAuthor('mindflood');
        let lastStatus = 200;
        for (let i = 0; i < 62; i++) {
            const res = await request(limitedApp)
                .post('/api/v1/assets/upload-signature')
                .set(bearer(a.token))
                .set('X-Forwarded-For', '203.0.113.55')
                .send({
                    purpose: 'MARKER_MIND',
                    fileName: `p${i}.mind`,
                    mimeType: 'application/octet-stream',
                    sizeBytes: 1024,
                });
            lastStatus = res.status;
            if (lastStatus === 429) break;
        }
        expect(lastStatus).toBe(429);
    });

    it('SEC-VW-04: Expired preview token returns 404 with no-store/no-referrer/noindex headers', async () => {
        const a = await createAuthor('prev');
        const owned = await seedBookWithPageAndAsset(a.userId);
        const activeToken = 'A'.repeat(32);
        const expiredToken = 'B'.repeat(32);
        const manifest = {
            schemaVersion: 1,
            bookId: owned.bookId,
            version: 1,
            title: 'Preview Test',
            trackerEngine: 'mindar',
            generatedAt: new Date().toISOString(),
            targetGroups: [],
            pages: [
                {
                    pageId: owned.pageId,
                    title: 'Trang 1',
                    aspect: 1.4,
                    imageUrl: 'https://cdn.example.com/p.jpg',
                    thumbnailUrl: 'https://cdn.example.com/t.jpg',
                    marker: { mode: 'NONE' },
                    settings: {},
                    scene: { schemaVersion: 1, objects: [], interactions: [] },
                },
            ],
            assets: {},
            credits: [],
        };
        await pool.query(
            `INSERT INTO preview_links (token, book_id, manifest, mind_groups, created_by, expires_at)
             VALUES ($1, $2, $3::jsonb, '[]'::jsonb, $5, now() + interval '1 hour'),
                    ($4, $2, $3::jsonb, '[]'::jsonb, $5, now() - interval '1 minute')`,
            [activeToken, owned.bookId, JSON.stringify(manifest), expiredToken, a.userId],
        );

        const ok = await request(app).get(`/api/v1/public/previews/${activeToken}`);
        expect(ok.status).toBe(200);
        expect(ok.headers['cache-control']).toBe('no-store, private');
        expect(ok.headers['referrer-policy']).toBe('no-referrer');
        expect(ok.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(ok.headers.expires).toBeTruthy();

        const expired = await request(app).get(`/api/v1/public/previews/${expiredToken}`);
        expect(expired.status).toBe(404);
    });

    it('SEC-VW-06 [GAP CHECK]: POST /public/events should deduplicate multiple OPEN events within the same sessionId', async () => {
        const a = await createAuthor('events');
        const owned = await seedBookWithPageAndAsset(a.userId);
        const versionId = randomUUID();
        await pool.query(
            `INSERT INTO book_versions (id, book_id, version_no, schema_version, manifest_public_id, mind_groups, page_count, ar_page_count, total_size_bytes)
             VALUES ($1, $2, 1, 1, 'bookaria/m.json', '[]'::jsonb, 1, 0, 100)`,
            [versionId, owned.bookId],
        );
        await pool.query(
            `UPDATE books SET status='PUBLISHED', visibility='PUBLIC', slug=$2, current_version_id=$3 WHERE id=$1`,
            [owned.bookId, `evt-${Date.now().toString(36)}`, versionId],
        );

        const sessionId = randomUUID();
        const nowIso = new Date().toISOString();
        const res = await request(app)
            .post('/api/v1/public/events')
            .send({
                sessionId,
                bookVersionId: versionId,
                device: { type: 'desktop', os: 'Linux', browser: 'Chrome' },
                events: Array.from({ length: 10 }, () => ({ type: 'OPEN', at: nowIso })),
            });
        expect(res.status).toBe(202);

        const { rows } = await pool.query<{ view_count: number }>(
            'SELECT view_count FROM books WHERE id = $1',
            [owned.bookId],
        );
        expect(rows[0]?.view_count).toBe('1');
    });

    it('SEC-E2E-02 & SEC-WK-06: CORS rejects untrusted origins, Helmet hides X-Powered-By, and errors never leak stack traces', async () => {
        const trustedOrigin = corsOrigins[0] ?? 'http://localhost:5173';
        const allowed = await request(app)
            .get('/api/v1/public/books')
            .set('Origin', trustedOrigin);
        expect(allowed.status).toBe(200);
        expect(allowed.headers['access-control-allow-origin']).toBe(trustedOrigin);
        expect(allowed.headers['access-control-allow-credentials']).toBe('true');
        expect(allowed.headers['x-powered-by']).toBeUndefined();

        const untrusted = await request(app)
            .get('/api/v1/public/books')
            .set('Origin', 'https://evil-cors.example');
        expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();

        const malformed = await request(app)
            .post('/api/v1/auth/login')
            .set('Content-Type', 'application/json')
            .send('{bad json');
        expect(malformed.status).toBe(400);
        expect(JSON.stringify(malformed.body)).not.toContain('SyntaxError');
        expect(JSON.stringify(malformed.body)).not.toContain('node_modules');
    });
});
