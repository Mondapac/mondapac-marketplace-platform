import type { Id } from '@mondapac/shared-kernel';
import { buildOfferMovedMapping } from './offer-moved-payload';

const v = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'Variant'>;

describe('buildOfferMovedMapping', () => {
  it('builds two equal-length lists read pairwise', () => {
    expect(
      buildOfferMovedMapping(
        [
          { from: v(1), to: v(11) },
          { from: v(2), to: v(12) },
        ],
        100,
      ),
    ).toEqual({
      ok: true,
      value: { fromVariantIds: [v(1), v(2)], toVariantIds: [v(11), v(12)] },
    });
  });

  it.each([
    ['empty', [], 3],
    ['too-many', [1, 2, 3, 4].map((n) => ({ from: v(n), to: v(n + 10) })), 3],
    [
      'duplicate',
      [
        { from: v(1), to: v(11) },
        { from: v(1), to: v(12) },
      ],
      3,
    ],
    [
      'duplicate',
      [
        { from: v(1), to: v(11) },
        { from: v(2), to: v(11) },
      ],
      3,
    ],
  ] as const)('refuses %s', (reason, pairs, max) => {
    expect(buildOfferMovedMapping(pairs, max)).toEqual({
      ok: false,
      error: { code: 'offer-moved.mapping-invalid', reason },
    });
  });
});
