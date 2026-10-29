import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { applyDeliveryMargin } from './delivery-margin';
import {
  isFresh,
  matchesScope,
  newDeliveryQuote,
  QUOTE_TTL_MINUTES,
  sameTotal,
  validUntilOf,
  type QuoteScope,
} from './delivery-quote';

// Quote freshness and pricing, run for both Market fixtures: AU (AUD, cents) and ZZ (JPY, no minor
// unit). Instants only; the clock is a value passed in.

const at = (iso: string) => Temporal.Instant.from(iso);
const NOW = at('2026-10-26T01:00:00Z');
const scope: QuoteScope = {
  accountId: 'a1111111-1111-4111-8111-111111111111' as Id<'Account'>,
  sellerId: 's1111111-1111-4111-8111-111111111111' as Id<'Seller'>,
  method: 'instant',
  dropoffPostcode: '4031',
};

describe('how long a quote holds', () => {
  it('holds 10 minutes when the fleet gives no expiry', () => {
    expect(QUOTE_TTL_MINUTES).toBe(10);
    expect(validUntilOf(NOW, null)?.toString()).toBe('2026-10-26T01:10:00Z');
  });

  it('holds until the fleet expiry when that is earlier than 10 minutes', () => {
    expect(validUntilOf(NOW, at('2026-10-26T01:04:00Z'))?.toString()).toBe('2026-10-26T01:04:00Z');
  });

  it('holds 10 minutes when the fleet expiry is later', () => {
    expect(validUntilOf(NOW, at('2026-10-26T02:00:00Z'))?.toString()).toBe('2026-10-26T01:10:00Z');
  });

  it('is unusable when the fleet expiry is not after the moment it was asked', () => {
    expect(validUntilOf(NOW, NOW)).toBeNull();
    expect(validUntilOf(NOW, at('2026-10-26T00:59:00Z'))).toBeNull();
  });
});

describe.each([['AUD'], ['JPY']] as const)('a delivery quote in %s', (currency) => {
  const priced = applyDeliveryMargin(money(1200n, currency), {
    margin: { kind: 'percent', basisPoints: 1000 },
    roundingStepMinor: 10,
  });
  const make = (fleetExpiresAt: Temporal.Instant | null = null) =>
    newDeliveryQuote({
      id: 'q1111111-1111-4111-8111-111111111111' as Id<'DeliveryQuote'>,
      scope,
      fleet: 'fake_test',
      priced,
      etaMinutes: 45,
      fleetExpiresAt,
      now: NOW,
    })!;

  it('carries the fleet price, the margin and the total the buyer pays', () => {
    const quote = make();
    expect(quote.quote).toEqual(money(1200n, currency));
    expect(quote.margin).toEqual(money(120n, currency));
    expect(quote.total).toEqual(money(1320n, currency));
    expect(quote.total.amount).toBe(quote.quote.amount + quote.margin.amount);
    expect(quote.quotedAt).toEqual(NOW);
  });

  it('is fresh before its expiry and stale at it', () => {
    const quote = make();
    expect(isFresh(quote, at('2026-10-26T01:09:59.999Z'))).toBe(true);
    expect(isFresh(quote, at('2026-10-26T01:10:00Z'))).toBe(false);
    expect(isFresh(quote, at('2026-10-26T03:00:00Z'))).toBe(false);
  });

  it('is stale at the fleet expiry when that is earlier', () => {
    const quote = make(at('2026-10-26T01:03:00Z'));
    expect(isFresh(quote, at('2026-10-26T01:02:59Z'))).toBe(true);
    expect(isFresh(quote, at('2026-10-26T01:03:00Z'))).toBe(false);
  });

  it('is not made from a fleet expiry that has passed', () => {
    const stale = newDeliveryQuote({
      id: 'q1111111-1111-4111-8111-111111111111' as Id<'DeliveryQuote'>,
      scope,
      fleet: 'fake_test',
      priced,
      etaMinutes: null,
      fleetExpiresAt: NOW,
      now: NOW,
    });
    expect(stale).toBeNull();
  });

  it('answers only the account, seller, method and postcode it was made for', () => {
    const quote = make();
    expect(matchesScope(quote, scope)).toBe(true);
    expect(matchesScope(quote, { ...scope, method: 'same_day' })).toBe(false);
    expect(matchesScope(quote, { ...scope, dropoffPostcode: '4000' })).toBe(false);
    expect(
      matchesScope(quote, {
        ...scope,
        accountId: 'b1111111-1111-4111-8111-111111111111' as Id<'Account'>,
      }),
    ).toBe(false);
    expect(
      matchesScope(quote, {
        ...scope,
        sellerId: 'b1111111-1111-4111-8111-111111111111' as Id<'Seller'>,
      }),
    ).toBe(false);
  });

  it('compares totals by amount and currency', () => {
    const a = make();
    expect(sameTotal(a, make())).toBe(true);
    expect(sameTotal(a, { total: money(1330n, currency) })).toBe(false);
    expect(sameTotal(a, { total: money(1320n, currency === 'AUD' ? 'JPY' : 'AUD') })).toBe(false);
  });
});
