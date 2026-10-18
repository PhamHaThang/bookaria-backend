import { type Document, type JSONDocument, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, simplify, unpartition, weld } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { JobError } from '../../modules/jobs/jobs.types';
import { ASSET_MAX_BYTES } from '../../schema';

// Số bytes tối đã của model sau khi tối ưu.
export const MAX_OUTPUT_MODEL_BYTES = 5 * 1024 * 1024;

// Số lượng tam giác mục tiêu sau khi tối ưu.
const TARGET_TRIANGLES = 50_000;

// Các định dạng texture được hỗ trợ.
const TEXTURE_SUPPORTED_FORMATS: readonly string[] = ['image/png', 'image/jpeg'] as const;

// 16 megapixel
const TEXTURE_MAX_PIXELS = 16_777_216;

// 1024px
const TEXTURE_MAX_DIMENSION = 1024;

/**
 * Tạo một NodeIO đã được đăng ký các extension và dependencies cần thiết để đọc/ghi file glTF.
 */
export async function modelIO() {
    await Promise.all([MeshoptDecoder.ready, MeshoptSimplifier.ready]);

    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
        'meshopt.decoder': MeshoptDecoder,
    });
}

/**
 * Đếm số lượng tam giác trong một Document glTF.
 */
export function triangleCount(doc: Document): number {
    return doc
        .getRoot()
        .listMeshes()
        .reduce(
            (total, mesh) =>
                total +
                mesh.listPrimitives().reduce((sum, p) => {
                    const n = (p.getIndices() ?? p.getAttribute('POSITION'))?.getCount() ?? 0;
                    if (p.getMode() === 4) return sum + Math.floor(n / 3);
                    if (p.getMode() === 5 || p.getMode() === 6) return sum + Math.max(0, n - 2);
                    return sum;
                }, 0),
            0,
        );
}

/**
 * Tối ưu một model glTF đầu vào.
 */
export async function optimizeModel(input: Uint8Array, signal: AbortSignal) {
    signal.throwIfAborted();
    if (input.byteLength > ASSET_MAX_BYTES.MODEL) {
        throw new JobError('MODEL_TOO_LARGE', 'Mô hình đầu vào vượt quá 10 MiB.');
    }
    const io = await modelIO();
    let doc: Document;
    try {
        // Kiểm tra xem file có phải là GLB hay không.
        const binary =
            input.length >= 4 &&
            new DataView(input.buffer, input.byteOffset, 4).getUint32(0, true) === 0x46546c67;

        // Đọc file glTF/GLB đầu vào.
        const jsonDoc: JSONDocument = binary
            ? await io.binaryToJSON(input)
            : { json: JSON.parse(Buffer.from(input).toString('utf8')), resources: {} };
        for (const r of [...(jsonDoc.json.buffers ?? []), ...(jsonDoc.json.images ?? [])]) {
            if (r.uri && !(r.uri in jsonDoc.resources) && !r.uri.startsWith('data:')) {
                throw new JobError(
                    'EXTERNAL_RESOURCE',
                    'Hãy xuất GLB có nhúng texture và dữ liệu.',
                );
            }
        }

        // Kiểm tra xem model có dùng extension chưa được hỗ trợ hay không.
        const supported = new Set(ALL_EXTENSIONS.map((ext) => ext.EXTENSION_NAME));
        if ((jsonDoc.json.extensionsUsed ?? []).some((name) => !supported.has(name))) {
            throw new JobError('UNSUPPORTED_MODEL', 'Mô hình dùng extension chưa được hỗ trợ.');
        }

        // Kiểm tra độ phức tạp của model.
        const declaredBytes = (jsonDoc.json.buffers ?? []).reduce((n, b) => n + b.byteLength, 0);
        const elements = (jsonDoc.json.accessors ?? []).reduce((n, a) => n + a.count, 0);
        if (declaredBytes > 128 * 1024 * 1024 || elements > 4_000_000) {
            throw new JobError('MODEL_COMPLEX', 'Mô hình quá phức tạp để xử lý.');
        }

        // Đọc Document glTF.
        doc = await io.readJSON(jsonDoc);
    } catch (err) {
        if (err instanceof JobError) throw err;
        throw new JobError(
            'INVALID_MODEL',
            'Không đọc được mô hình. Hãy xuất lại GLB có nhúng texture.',
        );
    }

    signal.throwIfAborted();
    const root = doc.getRoot();
    const before = triangleCount(doc);
    if (!before) {
        throw new JobError('EMPTY_MODEL', 'Mô hình không có lưới 3D.');
    }
    // Kiểm tra animation của Model.
    const animations = root.listAnimations().map((a) => a.getName() ?? 'unnamed');
    if (animations.some((name) => !name) || new Set(animations).size !== animations.length) {
        throw new JobError(
            'ANIMATION_NAMES',
            'Hãy đặt tên khác nhau, không để trống cho các clip animation.',
        );
    }
    // Kiểm tra topology của Model.
    const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
    if (primitives.some((p) => p.getMode() !== 4)) {
        throw new JobError('UNSUPPORTED_TOPOLOGY', 'Hãy xuất mô hình dưới dạng lưới tam giác.');
    }

    // Kiểm tra xem model có dùng morph target hay không.
    const hasMorph = primitives.some((p) => p.listTargets().length > 0);

    // Giảm số lượng tam giác bằng weld + simplify nếu cần thiết.
    // weld(): gộp các vertex trùng nhau để giảm số lượng vertex.
    // simplify(): giảm số lượng tam giác bằng thuật toán meshoptimizer.
    if (before > TARGET_TRIANGLES && !hasMorph) {
        await doc.transform(
            weld(),
            simplify({
                simplifier: MeshoptSimplifier,
                ratio: TARGET_TRIANGLES / before,
                error: 0.001,
            }),
        );
    }
    signal.throwIfAborted();

    // Tối ưu texture của model.
    for (const texture of root.listTextures()) {
        const bytes = texture.getImage();
        if (!bytes) continue;
        // Kiểm tra định dạng texture.
        if (!TEXTURE_SUPPORTED_FORMATS.includes(texture.getMimeType())) {
            throw new JobError(
                'UNSUPPORTED_TEXTURE',
                'Hãy xuất texture của mô hình ở định dạng PNG hoặc JPEG.',
            );
        }
        try {
            // Giới hạn kích thước texture và nén lại texture.
            const processor = sharp(Buffer.from(bytes), {
                limitInputPixels: TEXTURE_MAX_PIXELS,
            }).resize(TEXTURE_MAX_DIMENSION, TEXTURE_MAX_DIMENSION, {
                fit: 'inside',
                withoutEnlargement: true,
            });
            const png = texture.getMimeType() === 'image/png';
            const output = png
                ? await processor.png({ compressionLevel: 9 }).toBuffer()
                : await processor.jpeg({ quality: 80 }).toBuffer();
            texture.setImage(output);
        } catch {
            throw new JobError('INVALID_TEXTURE', 'Texture hỏng hoặc vượt giới hạn 16 megapixel.');
        }
        signal.throwIfAborted();
    }

    const after = triangleCount(doc);
    await doc.transform(unpartition(), draco());
    const output = await io.writeBinary(doc);
    signal.throwIfAborted();
    if (output.byteLength > MAX_OUTPUT_MODEL_BYTES) {
        throw new JobError(
            'MODEL_TOO_LARGE',
            'Mô hình sau tối ưu vẫn vượt quá 5 MiB. Hãy giảm texture hoặc chi tiết.',
        );
    }
    const warnings: string[] = [];
    if (after < before) warnings.push('MESH_SIMPLIFIED');
    if (after > TARGET_TRIANGLES) warnings.push('TRIANGLES_ABOVE_TARGET');
    if (hasMorph && before > TARGET_TRIANGLES) warnings.push('MORPH_SIMPLIFICATION_SKIPPED');
    return {
        bytes: output,
        meta: {
            triangles: after,
            originalTriangles: before,
            animations,
            downloadBytes: output.byteLength,
            geometryCompression: 'draco',
            warnings,
        },
    };
}
