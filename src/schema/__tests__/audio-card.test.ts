import { describe, expect, it } from 'vitest';
import { SceneObjectSchema, SceneSchema, sceneAssetIds } from '../scene.schema';

const assetId = '11111111-1111-4111-8111-111111111111';
const audio = { id: 'audio', type: 'audio', assetId, transform: {} };
describe('audio card contract', () => {
    it('preserves all fixed roles through JSON and accepts legacy scenes', () => {
        for (const audioKind of ['BGM', 'SFX', 'VOICE']) {
            const scene = SceneSchema.parse({
                schemaVersion: 1,
                objects: [
                    { ...audio, audioKind, name: 'Lời kể', billboard: true, autoplay: false },
                ],
            });
            expect(SceneSchema.parse(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
            expect(scene.objects[0]).toMatchObject({ audioKind, name: 'Lời kể' });
            expect([...sceneAssetIds(scene)]).toEqual([assetId]);
        }
        expect(SceneObjectSchema.parse(audio)).not.toHaveProperty('audioKind');
    });
    it('rejects unsupported roles', () => {
        for (const audioKind of ['music', 'bgm', 'Voice', '', null, 0])
            expect(SceneObjectSchema.safeParse({ ...audio, audioKind }).success).toBe(false);
    });
});
