import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { PromotionsFacade } from '../../promotions';
import { FacadeWasPriceCheck } from './facade-was-price-check';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const UNIT = { offerId: id<'Offer'>(0x1001), variantId: id<'Variant'>(0x2001) };

// The adapter over promotions' was-price rule: only an ok "eligible" answer is a yes; a refusal of
// any kind or a fault is "no" (fail closed), on both Market fixtures.
describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('FacadeWasPriceCheck in market %s', (code, currency) => {
  const context: CallContext = testCallContext(
    testMarketContext(code, 'default'),
    'anonymous',
    'was-price-0001-abc',
  );
  const PRICE = { amount: 1000n, currency };
  const check = (behaviour: () => Promise<unknown>) => {
    const calls: unknown[][] = [];
    const promotions = {
      wasPriceEligible: (...args: unknown[]) => {
        calls.push(args);
        return behaviour();
      },
    } as unknown as PromotionsFacade;
    return { sut: new FacadeWasPriceCheck(promotions), calls };
  };

  it('is yes for an eligible answer and passes the context, unit and price unchanged', async () => {
    const { sut, calls } = check(() => Promise.resolve(ok({ eligible: true })));

    expect(await sut.eligible(context, UNIT, PRICE)).toBe(true);
    expect(calls).toEqual([[context, UNIT, PRICE]]);
  });

  it('is no for a not-eligible answer', async () => {
    const { sut } = check(() => Promise.resolve(ok({ eligible: false })));
    expect(await sut.eligible(context, UNIT, PRICE)).toBe(false);
  });

  it.each([
    { code: 'promotions.disabled' },
    { code: 'promotions.unavailable' },
    { code: 'validation.failed', fields: [{ path: 'price', code: 'value' }] },
    { code: 'access.denied' },
  ])('is no for a refusal ($code)', async (error) => {
    const { sut } = check(() => Promise.resolve(err(error)));
    expect(await sut.eligible(context, UNIT, PRICE)).toBe(false);
  });

  it('is no when promotions throws', async () => {
    const { sut } = check(() => Promise.reject(new Error('down')));
    expect(await sut.eligible(context, UNIT, PRICE)).toBe(false);
  });
});
