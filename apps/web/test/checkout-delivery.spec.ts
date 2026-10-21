import { describe, expect, it } from 'vitest';
import { suggestPlaces } from '../src/checkout/address-search.ts';
import { deliveryQuotesFor } from '../src/checkout/actions.ts';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';

const places = SAMPLE_CHECKOUT.places;
const lines = (found: ReturnType<typeof suggestPlaces>) =>
  found.map((p) => (p.street ? `${p.street}, ${p.suburb}` : `${p.suburb} (suburb)`));

describe('address search suggestions (sample places)', () => {
  it('lists the suburbs of a postcode first, then its addresses', () => {
    expect(lines(suggestPlaces(places, '403', null))).toEqual([
      'Kedron (suburb)',
      'Chermside (suburb)',
      '12 Example Street, Kedron',
      '48 Test Avenue, Kedron',
      '7 Sandgate Road, Kedron',
      '7 Test Avenue, Chermside',
    ]);
  });

  it('suggests suburbs by name from two letters, and addresses by any part of the line', () => {
    expect(lines(suggestPlaces(places, 'k', null))).not.toContain('Kedron (suburb)');
    expect(lines(suggestPlaces(places, 'ke', null))[0]).toBe('Kedron (suburb)');
    expect(lines(suggestPlaces(places, 'brunswick paddington', null))).toEqual([]);
    expect(lines(suggestPlaces(places, 'brunswick street, padd', null))).toEqual([
      '12 Brunswick Street, Paddington',
    ]);
    expect(suggestPlaces(places, 'example', null).length).toBeLessThanOrEqual(7);
    expect(suggestPlaces(places, '   ', null)).toEqual([]);
  });

  it("lists only a picked suburb's streets", () => {
    const kedron = places.find((p) => p.id === 'kedron')!;
    expect(lines(suggestPlaces(places, '', kedron))).toEqual([
      '12 Example Street, Kedron',
      '48 Test Avenue, Kedron',
      '7 Sandgate Road, Kedron',
    ]);
    expect(lines(suggestPlaces(places, 'sand', kedron))).toEqual(['7 Sandgate Road, Kedron']);
  });
});

describe('delivery quotes (server action, sample courier)', () => {
  it('gives an Express price to the sellers that take Express orders now', async () => {
    const quotes = await deliveryQuotesFor({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron', 'paddington', 'mt-gravatt'],
    });
    expect(quotes).toEqual({
      kedron: { kind: 'quote', express: { amount: 1290, currency: 'AUD' } },
      paddington: { kind: 'quote', express: null },
      'mt-gravatt': { kind: 'quote', express: null },
    });
    expect(SAMPLE_CART_SOURCE.sellers.paddington!.express).toMatchObject({
      kind: 'closed',
      timeZone: 'Australia/Brisbane',
    });
    expect(SAMPLE_CART_SOURCE.sellers['mt-gravatt']!.express).toEqual({ kind: 'not-offered' });
  });

  it('answers nothing for a request that is not one', async () => {
    for (const raw of [
      null,
      'kedron',
      { address: { kind: 'saved', id: 'home' }, sellerIds: [] },
      { address: { kind: 'saved', id: 'home' }, sellerIds: ['a b'] },
      { address: { kind: 'saved', id: 'home' }, sellerIds: Array(51).fill('s') },
      { address: { kind: 'new', postcode: '' }, sellerIds: ['kedron'] },
      { address: { kind: 'new', postcode: '4'.repeat(11) }, sellerIds: ['kedron'] },
      { address: { kind: 'new', postcode: '4' }, sellerIds: ['kedron'] },
      { address: { kind: 'new', postcode: '40<1' }, sellerIds: ['kedron'] },
      { address: { kind: 'saved', id: 'home' }, sellerIds: ['kedron', 'kedron'] },
      { address: { kind: 'other', id: 'home' }, sellerIds: ['kedron'] },
    ])
      expect(await deliveryQuotesFor(raw)).toEqual({});
    expect(
      await deliveryQuotesFor({
        address: { kind: 'new', postcode: ' 4031 ' },
        sellerIds: ['inala'],
      }),
    ).toEqual({ inala: { kind: 'quote', express: { amount: 1190, currency: 'AUD' } } });
  });
});
