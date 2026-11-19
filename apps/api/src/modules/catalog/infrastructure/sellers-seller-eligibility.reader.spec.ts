import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import { SellersSellerEligibilityReader } from './sellers-seller-eligibility.reader';

// The status the import run reads (catalog design 14c): a failed read or an unavailable gate is
// "unavailable" (wait and retry); only an answer of "no", a denial or a refusal is "not eligible".

const SELLER = '01990000-0000-7000-8000-0000000000b1' as Id<'Seller'>;
const context = {} as CallContext;

const readerOf = (answer: () => Promise<unknown>) =>
  new SellersSellerEligibilityReader({ sellingEligibility: answer } as unknown as SellersFacade);

describe('SellersSellerEligibilityReader.status', () => {
  it('answers eligible and not-eligible from the map', async () => {
    const yes = readerOf(() =>
      Promise.resolve({ ok: true, value: new Map([[SELLER, { eligible: true }]]) }),
    );
    const no = readerOf(() =>
      Promise.resolve({ ok: true, value: new Map([[SELLER, { eligible: false }]]) }),
    );
    expect(await yes.status(context, SELLER)).toBe('eligible');
    expect(await no.status(context, SELLER)).toBe('not-eligible');
    expect(
      await readerOf(() => Promise.resolve({ ok: true, value: new Map() })).status(context, SELLER),
    ).toBe('not-eligible');
  });

  it.each(['sellers.unavailable', 'access.unavailable'])(
    'answers unavailable for %s',
    async (errorCode) => {
      const reader = readerOf(() => Promise.resolve({ ok: false, error: { code: errorCode } }));
      expect(await reader.status(context, SELLER)).toBe('unavailable');
    },
  );

  it('answers not-eligible for a denial and unavailable for a thrown error', async () => {
    const denied = readerOf(() => Promise.resolve({ ok: false, error: { code: 'access.denied' } }));
    expect(await denied.status(context, SELLER)).toBe('not-eligible');
    const thrown = readerOf(() => Promise.reject(new Error('down')));
    expect(await thrown.status(context, SELLER)).toBe('unavailable');
  });
});
