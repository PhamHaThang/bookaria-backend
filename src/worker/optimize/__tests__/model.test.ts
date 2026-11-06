import { Document, Format, NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { modelIO, optimizeModel, triangleCount } from '../model';

function texturedModel(image: Uint8Array, mimeType = 'image/webp') {
    const doc = new Document();
    if (mimeType === 'image/webp') doc.createExtension(EXTTextureWebP).setRequired(true);
    const buffer = doc.createBuffer();
    const positions = doc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
        .setBuffer(buffer);
    const uvs = doc
        .createAccessor()
        .setType('VEC2')
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
        .setBuffer(buffer);
    const texture = doc.createTexture('Color').setMimeType(mimeType).setImage(image);
    const material = doc.createMaterial().setBaseColorTexture(texture).setAlphaMode('BLEND');
    const primitive = doc
        .createPrimitive()
        .setAttribute('POSITION', positions)
        .setAttribute('TEXCOORD_0', uvs)
        .setMaterial(material);
    doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
    return doc;
}

describe('optimizeModel', () => {
    it('keeps a small model intact and writes readable Draco geometry', async () => {
        const doc = new Document();
        const buffer = doc.createBuffer();
        const positions = doc
            .createAccessor()
            .setType('VEC3')
            .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
            .setBuffer(buffer);
        const primitive = doc.createPrimitive().setAttribute('POSITION', positions);
        doc.createScene().addChild(
            doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)),
        );

        const input = await new NodeIO().writeBinary(doc);
        const output = await optimizeModel(input, new AbortController().signal);
        const decoded = await (await modelIO()).readBinary(output.bytes);

        expect(triangleCount(decoded)).toBe(1);
        expect(output.meta).toMatchObject({
            triangles: 1,
            originalTriangles: 1,
            geometryCompression: 'draco',
            warnings: [],
            downloadBytes: output.bytes.byteLength,
        });
    });

    it('preserves morph targets on a model above the simplification threshold', async () => {
        const side = 160; // 51,200 triangles.
        const positions = new Float32Array((side + 1) * (side + 1) * 3);
        const deltas = new Float32Array(positions.length);
        const indices = new Uint32Array(side * side * 6);
        for (let y = 0; y <= side; y++) {
            for (let x = 0; x <= side; x++) {
                const i = (y * (side + 1) + x) * 3;
                positions[i] = x / side;
                positions[i + 1] = y / side;
                deltas[i + 2] = 0.1;
            }
        }
        for (let y = 0; y < side; y++) {
            for (let x = 0; x < side; x++) {
                const vertex = y * (side + 1) + x;
                const i = (y * side + x) * 6;
                indices.set(
                    [
                        vertex,
                        vertex + 1,
                        vertex + side + 1,
                        vertex + 1,
                        vertex + side + 2,
                        vertex + side + 1,
                    ],
                    i,
                );
            }
        }

        const doc = new Document();
        const buffer = doc.createBuffer();
        const position = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer);
        const morph = doc.createAccessor().setType('VEC3').setArray(deltas).setBuffer(buffer);
        const index = doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer);
        const primitive = doc
            .createPrimitive()
            .setAttribute('POSITION', position)
            .setIndices(index)
            .addTarget(doc.createPrimitiveTarget().setAttribute('POSITION', morph));
        doc.createScene().addChild(
            doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)),
        );

        const input = await new NodeIO().writeBinary(doc);
        const output = await optimizeModel(input, new AbortController().signal);
        const decoded = await (await modelIO()).readBinary(output.bytes);

        expect(triangleCount(decoded)).toBe(side * side * 2);
        expect(decoded.getRoot().listMeshes()[0]?.listPrimitives()[0]?.listTargets()).toHaveLength(
            1,
        );
        expect(output.meta.warnings).toContain('MORPH_SIMPLIFICATION_SKIPPED');
    }, 30_000);

    it.each(['glb', 'gltf'])(
        'accepts embedded WebP in %s and preserves its pixels and alpha',
        async (format) => {
            const pixels = Buffer.alloc(32 * 16 * 4);
            for (let i = 0; i < pixels.length; i += 4) {
                pixels.set([35, 150, 220, i % 12 === 0 ? 90 : 255], i);
            }
            const image = await sharp(pixels, { raw: { width: 32, height: 16, channels: 4 } })
                .webp({ lossless: true })
                .toBuffer();
            const io = await modelIO();
            const doc = texturedModel(image);
            let input: Uint8Array;
            if (format === 'gltf') {
                const json = await io.writeJSON(doc, { format: Format.GLTF, basename: 'test' });
                for (const resource of [
                    ...(json.json.buffers || []),
                    ...(json.json.images || []),
                ]) {
                    if (resource.uri) {
                        const bytes = json.resources[resource.uri];
                        if (!bytes) throw new Error('Missing embedded resource');
                        const mime =
                            'mimeType' in resource ? resource.mimeType : 'application/octet-stream';
                        resource.uri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
                    }
                }
                input = Buffer.from(JSON.stringify(json.json));
            } else input = await io.writeBinary(doc);
            const output = await optimizeModel(input, new AbortController().signal);
            await expectWebP(output.bytes, image, io);
        },
    );

    it('resizes WebP within 1024 px while retaining its aspect ratio and transparency', async () => {
        const image = await sharp({
            create: {
                width: 2048,
                height: 1024,
                channels: 4,
                background: { r: 50, g: 100, b: 150, alpha: 0.5 },
            },
        })
            .webp({ lossless: true })
            .toBuffer();
        const io = await modelIO();
        const input = await io.writeBinary(texturedModel(image));
        const output = await optimizeModel(input, new AbortController().signal);
        const decoded = await io.readBinary(output.bytes);
        const texture = decoded.getRoot().listTextures()[0];
        if (!texture) throw new Error('Missing optimized texture');
        expect(texture.getMimeType()).toBe('image/webp');
        expect(
            await sharp(Buffer.from(texture.getImage() ?? new Uint8Array())).metadata(),
        ).toMatchObject({
            format: 'webp',
            width: 1024,
            height: 512,
            hasAlpha: true,
        });
    });

    it('rejects a WebP payload that cannot be decoded', async () => {
        const image = await sharp({
            create: {
                width: 32,
                height: 16,
                channels: 4,
                background: '#25809a80',
            },
        })
            .webp({ lossless: true })
            .toBuffer();
        // Keep the format/dimension headers readable, but corrupt the encoded pixels.
        image.fill(0xff, 25);
        const io = await modelIO();
        const input = await io.writeBinary(texturedModel(image));
        await expect(optimizeModel(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'INVALID_TEXTURE',
        });
    });

    it('keeps the input pixel limit for WebP textures', async () => {
        const image = await sharp({
            create: {
                width: 5000,
                height: 4000,
                channels: 3,
                background: '#25809a',
            },
        })
            .webp({ lossless: true })
            .toBuffer();
        const io = await modelIO();
        const input = await io.writeBinary(texturedModel(image));
        await expect(optimizeModel(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'INVALID_TEXTURE',
        });
    });

    it.each(['png', 'jpeg'] as const)(
        'continues accepting embedded %s textures',
        async (format) => {
            const image = await sharp({
                create: {
                    width: 16,
                    height: 16,
                    channels: 3,
                    background: '#25809a',
                },
            })
                .toFormat(format)
                .toBuffer();
            const io = await modelIO();
            const output = await optimizeModel(
                await io.writeBinary(texturedModel(image, `image/${format}`)),
                new AbortController().signal,
            );
            const texture = (await io.readBinary(output.bytes)).getRoot().listTextures()[0];
            if (!texture) throw new Error('Missing optimized texture');
            expect(texture.getMimeType()).toBe(`image/${format}`);
            expect(
                await sharp(Buffer.from(texture.getImage() ?? new Uint8Array())).metadata(),
            ).toMatchObject({
                format,
            });
        },
    );
});

async function expectWebP(bytes: Uint8Array, original: Uint8Array, io: NodeIO) {
    const json = (await io.binaryToJSON(bytes)).json;
    expect(json.extensionsUsed).toContain('EXT_texture_webp');
    expect(json.extensionsRequired).toContain('EXT_texture_webp');
    expect(json.textures?.[0]?.extensions?.EXT_texture_webp).toEqual({ source: 0 });
    const decoded = await io.readBinary(bytes);
    const texture = decoded.getRoot().listTextures()[0];
    if (!texture) throw new Error('Missing optimized WebP texture');
    expect(texture.getMimeType()).toBe('image/webp');
    const image = Buffer.from(texture.getImage() ?? new Uint8Array());
    expect(await sharp(image).metadata()).toMatchObject({
        format: 'webp',
        width: 32,
        height: 16,
        hasAlpha: true,
    });
    expect(await sharp(image).ensureAlpha().raw().toBuffer()).toEqual(
        await sharp(Buffer.from(original)).ensureAlpha().raw().toBuffer(),
    );
    expect(decoded.getRoot().listMaterials()[0]?.getBaseColorTexture()).toBe(texture);
    expect(triangleCount(decoded)).toBe(1);
}
