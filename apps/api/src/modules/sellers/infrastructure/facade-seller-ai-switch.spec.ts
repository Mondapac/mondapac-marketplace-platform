import type { Id } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SellersFacade } from '../contracts/sellers.facade';
import { FacadeSellerAiSwitch } from './facade-seller-ai-switch';

const SELLER = '01938a2b-4123-7456-8abc-0123456789ab' as Id<'Seller'>;

describe('FacadeSellerAiSwitch (SEL-25; ADR-0019 decision 7: an error is off)', () => {
  const switchOf = (aiAccessOf: SellersFacade['aiAccessOf']) =>
    new FacadeSellerAiSwitch({ aiAccessOf } as unknown as SellersFacade);

  it.each([
    ['AU', testMarketContext('AU', 'default')],
    ['ZZ', testMarketContext('ZZ', 'default')],
  ])('is on only for an explicit on (%s)', async (_name, market) => {
    const context = testCallContext(market, 'system');
    expect(await switchOf(() => Promise.resolve(ok(true))).isOn(context, SELLER)).toBe(true);
    expect(await switchOf(() => Promise.resolve(ok(false))).isOn(context, SELLER)).toBe(false);
    expect(
      await switchOf(() =>
        Promise.resolve(err({ code: 'sellers.unavailable' } as never)),
      ).isOn(context, SELLER),
    ).toBe(false);
    expect(await switchOf(() => Promise.reject(new Error('down'))).isOn(context, SELLER)).toBe(
      false,
    );
  });

  it('passes the caller context and seller through unchanged', async () => {
    const context = testCallContext(testMarketContext('AU', 'default'), 'system');
    const calls: unknown[] = [];
    await switchOf((c, s) => {
      calls.push([c, s]);
      return Promise.resolve(ok(true));
    }).isOn(context, SELLER);
    expect(calls).toEqual([[context, SELLER]]);
  });
});
