import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { modelIO, optimizeModel, triangleCount } from '../model';

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
});
