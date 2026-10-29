import { describe, expect, it } from 'vitest';
import { suggestPlaces } from '../src/checkout/address-search.ts';
import { deliveryOptionsFor } from '../src/checkout/actions.ts';
import { SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';

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

describe('delivery options (server action, sample stand-in)', () => {
  it('gives each seller its four methods, with the state its sample is built to show', async () => {
    const answer = await deliveryOptionsFor({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron', 'paddington', 'sunnybank', 'inala', 'logan-road'],
    });
    if (answer.kind !== 'ok') throw new Error('expected options');
    const state = (id: string) =>
      Object.fromEntries(
        answer.sellers[id]!.methods.map((m) => [m.method, m.reason ?? m.price?.state]),
      );
    expect(state('kedron')).toEqual({
      pickup: 'free',
      instant: 'quoted',
      same_day: 'quoted',
      scheduled: 'quoted',
    });
    expect(state('paddington')).toMatchObject({ same_day: 'past-cut-off' });
    expect(state('sunnybank')).toMatchObject({ instant: 'seller-unsupported' });
    expect(state('inala')).toMatchObject({ pickup: 'no-pickup-address' });
    expect(state('logan-road')).toMatchObject({ instant: 'failed', scheduled: 'no-fleet' });
    expect(answer.sellers.inala!.pickupPostcode).toBeNull();
  });

  it('quotes GST inside the total, apart from it', async () => {
    const answer = await deliveryOptionsFor({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron'],
    });
    if (answer.kind !== 'ok') throw new Error('expected options');
    const instant = answer.sellers.kedron!.methods.find((m) => m.method === 'instant')!;
    expect(instant.price).toMatchObject({
      state: 'quoted',
      total: { amount: 1290, currency: 'AUD' },
      tax: { amount: 117, currency: 'AUD' },
    });
  });

  it('answers failed for a request that is not one', async () => {
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
      expect(await deliveryOptionsFor(raw)).toEqual({ kind: 'failed' });
    expect(
      await deliveryOptionsFor({
        address: { kind: 'new', postcode: ' 4031 ' },
        sellerIds: ['inala'],
      }),
    ).toMatchObject({ kind: 'ok' });
  });
});
