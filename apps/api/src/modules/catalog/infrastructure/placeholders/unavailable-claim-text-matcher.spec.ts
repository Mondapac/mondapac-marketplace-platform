import {
  SequenceIdGenerator,
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import type { ClaimTextMatcher } from '../../application/ports/claim-text-matcher';
import { UnavailableClaimTextMatcher } from './unavailable-claim-text-matcher';

// ADR-0031 decision 2a: a constant answer, whatever the Market or the texts.
describe.each(['AU', 'ZZ'] as const)('UnavailableClaimTextMatcher in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(
    new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z')),
  );
  const context = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: ids.next<'Seller'>(),
    }),
  );
  const matcher: ClaimTextMatcher = new UnavailableClaimTextMatcher();

  it.each([
    [[]],
    [[{ locale: 'en', text: 'plain words' }]],
    [
      [
        { locale: 'xx', text: '' },
        { locale: 'en', text: 'a'.repeat(30_000) },
      ],
    ],
  ])('answers unavailable for %j', async (texts) => {
    await expect(matcher.match(context, texts)).resolves.toEqual({
      ok: false,
      error: { code: 'claim-text.check-unavailable' },
    });
  });
});
