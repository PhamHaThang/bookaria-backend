import { expect, it, vi } from 'vitest';
import { randomBase36Suffix } from '../slug';

const { draw } = vi.hoisted(() => ({ draw: vi.fn(() => 35) }));
vi.mock('node:crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:crypto')>()),
    randomInt: draw,
}));

it('uses random values for every suffix character including the last one', () => {
    draw.mockReturnValueOnce(0).mockReturnValueOnce(9).mockReturnValueOnce(10);
    expect(randomBase36Suffix(6)).toBe('09azzz');
    expect(draw).toHaveBeenCalledTimes(6);
    for (const args of draw.mock.calls) expect(args).toEqual([36]);
});
