import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { AssetRow } from '../../../modules/assets/assets.types';
import { account, fakeR2 } from '../../../test/r2';
import { optimizeModel } from '../model';
import { createProcessingStorage } from '../storage';

describe('local model thumbnails', () => {
    it.each([false, true])(
        'renders Draco input with supplied bytes: %s',
        async (reuse) => {
            const doc = new Document(),
                buffer = doc.createBuffer();
            const positions = doc
                .createAccessor()
                .setType('VEC3')
                .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
                .setBuffer(buffer);
            const material = doc
                .createMaterial()
                .setBaseColorFactor([1, 0, 0, 1])
                .setDoubleSided(true)
                .setMetallicFactor(0);
            const primitive = doc
                .createPrimitive()
                .setAttribute('POSITION', positions)
                .setMaterial(material);
            doc.createScene().addChild(
                doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)),
            );
            const signal = new AbortController().signal;
            const optimized = await optimizeModel(await new NodeIO().writeBinary(doc), signal);
            const fake = fakeR2();
            if (!reuse)
                fake.files.set('bookaria/optimized', {
                    bytes: optimized.bytes,
                    type: 'model/gltf-binary',
                    format: 'glb',
                });
            const storage = createProcessingStorage(account, fake.network);
            await storage.thumbnail(
                {
                    id: 'model',
                    type: 'MODEL',
                    original_public_id: 'missing-source',
                    optimized_public_id: 'bookaria/optimized',
                } as AssetRow,
                signal,
                reuse ? optimized.bytes : undefined,
            );
            expect(
                fake.network.mock.calls.filter(
                    ([request]) => request instanceof Request && request.method === 'GET',
                ),
            ).toHaveLength(reuse ? 0 : 1);
            const stored = fake.files.get('bookaria/thumbnails/model.jpg');
            assert(stored);
            const image = stored.bytes;
            expect(await sharp(image).metadata()).toMatchObject({
                width: 320,
                height: 320,
                format: 'jpeg',
            });
            const statistics = await sharp(image).stats();
            const red = statistics.channels[0],
                blue = statistics.channels[2];
            assert(red && blue);
            expect(red.mean).toBeGreaterThan(blue.mean + 5);
        },
        60_000,
    );
});
