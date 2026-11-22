import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { CertificationFacadeImplementation } from '../../presentation/certification.facade';
import { MatchCandidateClaimTerms } from './match-candidate-claim-terms.use-case';
import { MatchCandidateClaimTermsSystem } from './match-candidate-claim-terms-system.use-case';

// `matchCandidateClaimTerms` (catalog request X-1, design 6.5): a candidate term list matched
// against texts with the real matcher, on both Market fixtures. No reader: the published
// vocabulary is never consulted.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
let holder = true;
const authorisation: AuthorisationCheck = {
  check: () =>
    Promise.resolve(
      holder ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
    ),
};
const gate = createUseCaseGate(markets, authorisation);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-11-22T10:00:00Z')));

describe.each(['AU', 'ZZ'])('matchCandidateClaimTerms, Market %s', (marketCode) => {
  const market = () => testMarketContext(marketCode, 'default');
  const locales = () => markets.get(marketCode as never).supportedLocales;
  const supportedLocales = () => locales();
  const request = new MatchCandidateClaimTerms(gate, () => supportedLocales());
  const jobs = new MatchCandidateClaimTermsSystem(gate, () => supportedLocales());
  const facade = new CertificationFacadeImplementation({
    matchCandidateClaimTerms: request,
    matchCandidateClaimTermsSystem: jobs,
  } as never);
  const [first, second] = [locales()[0]!, locales()[1] ?? locales()[0]!];

  const person = (population: 'seller' | 'admin', actingAs = false): CallContext => {
    const context = testCallContext(
      market(),
      testAuthenticatedActor(market(), {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );
    return actingAs
      ? ({
          ...context,
          actor: { ...context.actor, actingAs: { accountId: 'x', sellerId: 'y' } },
        } as unknown as CallContext)
      : context;
  };
  // One locale of the Market holds Latin terms, another (or the same one) an Arabic term.
  const candidate = {
    termsByLocale:
      first === second
        ? { [first]: ['Zorbex Pure', 'شوفان'] }
        : { [first]: ['Zorbex Pure'], [second]: ['شوفان'] },
  };

  beforeEach(() => {
    holder = true;
  });

  it('matches texts against the candidate terms of every locale, with the matcher normalisation', async () => {
    const r = await facade.matchCandidateClaimTerms(person('admin'), candidate, [
      { locale: first, text: 'Our ZORBEX   pure oats' },
      { locale: first, text: 'plain oats' },
      { locale: first, text: 'Z0rbex-Pure!' },
      { locale: first, text: 'شوفان كامل' }, // a term of another locale applies to any text
    ]);
    expect(r.ok && r.value.map((m) => m.length > 0)).toEqual([true, false, true, true]);
  });

  it('uses only the candidate terms, never the published vocabulary', async () => {
    // The published vocabularies hold words such as "halal"; the candidate does not.
    const r = await facade.matchCandidateClaimTerms(person('admin'), candidate, [
      { locale: first, text: 'halal kosher vegan' },
    ]);
    expect(r.ok && r.value[0]).toEqual([]);
  });

  it('labels the match with the type code, or a fixed label for a type not yet created', async () => {
    const named = await facade.matchCandidateClaimTerms(
      person('admin'),
      { ...candidate, typeCode: 'zorbex' },
      [{ locale: first, text: 'zorbex pure' }],
    );
    expect(named.ok && named.value[0]![0]!.typeCode).toBe('zorbex');
    const unnamed = await facade.matchCandidateClaimTerms(person('admin'), candidate, [
      { locale: first, text: 'zorbex pure' },
    ]);
    expect(unnamed.ok && unnamed.value[0]![0]!.typeCode).toBe('candidate');
  });

  it('refuses terms the matcher cannot use, never dropping them', async () => {
    for (const terms of [['ab'], [' - '], ['ok term', '!!'], ['x'.repeat(101)], ['<b>bold</b>']]) {
      const r = await facade.matchCandidateClaimTerms(
        person('admin'),
        { termsByLocale: { [first]: terms } },
        [{ locale: first, text: 'anything' }],
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe('validation.failed');
    }
  });

  it('refuses a locale the Market does not support, no terms at all, and a malformed body', async () => {
    const bad: unknown[] = [
      { termsByLocale: { xx: ['zorbex pure'] } },
      { termsByLocale: {} },
      { termsByLocale: { [first]: [] } },
      { termsByLocale: { [first]: 'zorbex pure' } },
      { termsByLocale: [] },
      { termsByLocale: null },
      { typeCode: 'Not A Code', termsByLocale: { [first]: ['zorbex pure'] } },
      null,
    ];
    for (const body of bad) {
      const r = await facade.matchCandidateClaimTerms(person('admin'), body as never, [
        { locale: first, text: 'x' },
      ]);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe('validation.failed');
    }
  });

  it('keeps the matcher text limits: 100 texts of 20,000 characters', async () => {
    const hundred = Array.from({ length: 100 }, () => ({ locale: first, text: 'zorbex pure' }));
    const ok = await facade.matchCandidateClaimTerms(person('admin'), candidate, hundred);
    expect(ok.ok && ok.value.length).toBe(100);
    const tooMany = await facade.matchCandidateClaimTerms(person('admin'), candidate, [
      ...hundred,
      { locale: first, text: 'x' },
    ]);
    expect(tooMany).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'texts', code: 'length' }] },
    });
    const tooLong = await facade.matchCandidateClaimTerms(person('admin'), candidate, [
      { locale: first, text: 'x'.repeat(20_001) },
    ]);
    expect(tooLong).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'texts.0.text', code: 'length' }] },
    });
  });

  it('refuses everyone but an admin who holds certification.type.edit, and acting-as', async () => {
    const texts = [{ locale: first, text: 'zorbex pure' }];
    const anonymous = testCallContext(market(), 'anonymous');
    for (const context of [anonymous, person('seller'), person('admin', true)]) {
      const r = await request.execute(context, { candidate, texts });
      expect(r.ok).toBe(false);
    }
    holder = false;
    expect((await request.execute(person('admin'), { candidate, texts })).ok).toBe(false);
    holder = true;
    expect((await request.execute(person('admin'), { candidate, texts })).ok).toBe(true);
  });

  it('serves the system actor through the pair, which refuses request actors', async () => {
    const texts = [{ locale: first, text: 'zorbex pure' }];
    const system = testCallContext(market(), 'system');
    const viaFacade = await facade.matchCandidateClaimTerms(system, candidate, texts);
    expect(viaFacade.ok && viaFacade.value[0]!.length).toBeGreaterThan(0);
    expect((await request.execute(system, { candidate, texts })).ok).toBe(false);
    expect((await jobs.execute(person('admin'), { candidate, texts })).ok).toBe(false);
  });
});
