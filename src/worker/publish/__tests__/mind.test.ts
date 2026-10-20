import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decode, encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';
import { compressGroup, decodeSingleMind, encodeGroup, MAX_MIND_BYTES } from '../mind';

const real = readFileSync(new URL('./fixtures/card.mind', import.meta.url));
describe('MindAR 1.2.5 MessagePack packaging', () => {
    it('reads the real upstream single-target fixture', () => {
        const target = decodeSingleMind(real);
        expect(target.targetImage.width).toBeGreaterThan(0);
        expect(target.matchingData.length).toBeGreaterThan(0);
        expect(target.trackingData.length).toBeGreaterThan(0);
    });
    it('preserves real binary feature data and target order through merge and gzip', () => {
        const first = decodeSingleMind(real),
            second = { ...first, targetImage: { ...first.targetImage, width: 321 } };
        const output = encodeGroup([first, second]);
        expect(decode(output)).toEqual({ v: 2, dataList: [first, second] });
        expect(gunzipSync(compressGroup(output))).toEqual(output);
        expect(() => decodeSingleMind(output)).toThrow(/một target/);
    });
    it.each([0, 11])('rejects %i targets in a group', (count) => {
        expect(() =>
            encodeGroup(Array.from({ length: count }, () => decodeSingleMind(real))),
        ).toThrow();
    });
    it.each([
        Buffer.from('invalid'),
        Buffer.from(encode({ v: 1, dataList: [] })),
        Buffer.from(
            encode({
                v: 2,
                dataList: [
                    { targetImage: { width: 1, height: 1 }, matchingData: [], trackingData: [] },
                ],
            }),
        ),
        compressGroup(real),
    ])('rejects invalid, old, empty or gzip input', (bytes) => {
        expect(() => decodeSingleMind(bytes)).toThrow();
    });
    it('rejects input byte overflow before decoding', () => {
        expect(() => decodeSingleMind(new Uint8Array(MAX_MIND_BYTES + 1))).toThrow(/5 MiB/);
    });
});
