import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { CertificationFacadeImplementation } from '../../presentation/certification.facade';
import type { ClaimVocabularyEntry } from '../../domain/claim-text-matcher';
import type { CertificationTypeCode } from '../../domain/claim-types';
import type { CertificationTypeView } from '../../contracts/certification.facade';
import type { PublishedTypesReader } from '../ports/published-types.reader';
import { CertificationTypesSystem } from './certification-types-system.use-case';
import { CertificationTypes } from './certification-types.use-case';
import { MatchClaimTermsSystem } from './match-claim-terms-system.use-case';
import { MatchClaimTerms } from './match-claim-terms.use-case';

const code = (s: string): CertificationTypeCode => s as CertificationTypeCode;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z')));

// A test-only reader: per Market, a vocabulary of its own (AU and the synthetic ZZ differ).
const VOCAB: Record<string, ClaimVocabularyEntry[]> = {
  AU: [{ typeCode: code('halal'), terms: ['halal', 'حلال'] }],
  ZZ: [{ typeCode: code('zed-pure'), terms: ['zedpure', 'зед чисто'] }],
};
const typeView = (c: string, status: 'active' | 'inactive'): CertificationTypeView => ({
  code: code(c),
  status,
  publishedRevisionId: ids.next(),
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  requiresIssuerRegistry: true,
  requiresDocument: true,
  requiresExpiry: true,
  defaultBasis: 'SELLER_REQUIRED',
  autoApproveSelfDeclaration: false,
  badgeIconKey: 'seal',
  locales: { en: { name: c, customerDescription: c } },
});
let failing = false;
const reader: PublishedTypesReader = {
  claimVocabulary: (market) =>
    failing ? Promise.reject(new Error('db down')) : Promise.resolve(VOCAB[market.marketId] ?? []),
  types: (market, filter) => {
    if (failing) return Promise.reject(new Error('db down'));
    const all = [
      typeView(`a-${market.marketId.toLowerCase()}`, 'active'),
      typeView('b-off', 'inactive'),
    ];
    return Promise.resolve(filter.status ? all.filter((t) => t.status === filter.status) : all);
  },
};

describe.each(['AU', 'ZZ'])('certification facade reads, Market %s', (marketCode) => {
  const market = () => testMarketContext(marketCode, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const system = () => testCallContext(market(), 'system');
  const facade = new CertificationFacadeImplementation({
    matchClaimTerms: new MatchClaimTerms(gate, reader),
    matchClaimTermsSystem: new MatchClaimTermsSystem(gate, reader),
    certificationTypes: new CertificationTypes(gate, reader),
    certificationTypesSystem: new CertificationTypesSystem(gate, reader),
  });
  const own = marketCode === 'AU' ? 'halal' : 'зед чисто';
  const other = marketCode === 'AU' ? 'зед чисто' : 'halal';

  beforeEach(() => {
    failing = false;
  });

  it('matches the Market vocabulary for both callers, the same answer', async () => {
    const texts = [
      { locale: 'en', text: `fresh ${own} chicken` },
      { locale: 'en', text: `fresh ${other} chicken` },
      { locale: 'en', text: 'plain' },
    ];
    const a = await facade.matchClaimTerms(anonymous(), texts);
    const s = await facade.matchClaimTerms(system(), texts);
    expect(a).toEqual(s);
    expect(a.ok && a.value.map((m) => m.length)).toEqual([1, 0, 0]);
  });

  it('is fail closed: a failed read is unavailable, never an empty answer', async () => {
    failing = true;
    const r = await facade.matchClaimTerms(anonymous(), [{ locale: 'en', text: own }]);
    expect(r).toEqual({ ok: false, error: { code: 'certification.unavailable' } });
    const t = await facade.certificationTypes(system(), {});
    expect(t).toEqual({ ok: false, error: { code: 'certification.unavailable' } });
  });

  it('refuses a malformed or oversized request whole, before any read', async () => {
    failing = true; // a read would turn this into "unavailable"
    const refused = async (texts: unknown) => {
      const r = await facade.matchClaimTerms(anonymous(), texts as never);
      return r.ok ? null : r.error.code;
    };
    expect(await refused(Array.from({ length: 101 }, () => ({ locale: 'en', text: 'x' })))).toBe(
      'validation.failed',
    );
    expect(await refused([{ locale: 'en', text: 'a'.repeat(20_001) }])).toBe('validation.failed');
    expect(await refused([{ locale: 'bad locale', text: 'x' }])).toBe('validation.failed');
    expect(await refused([{ locale: 'en' }])).toBe('validation.failed');
    expect(await refused([null])).toBe('validation.failed');
    expect(await refused('x')).toBe('validation.failed');
  });

  it('accepts exactly 100 texts and answers an empty list with an empty answer', async () => {
    const hundred = Array.from({ length: 100 }, () => ({ locale: 'en', text: own }));
    const r = await facade.matchClaimTerms(anonymous(), hundred);
    expect(r.ok && r.value.length).toBe(100);
    const empty = await facade.matchClaimTerms(anonymous(), []);
    expect(empty).toEqual({ ok: true, value: [] });
  });

  it('lists types and filters by status, refusing an unknown status', async () => {
    const all = await facade.certificationTypes(anonymous(), {});
    expect(all.ok && all.value.length).toBe(2);
    const active = await facade.certificationTypes(system(), { status: 'active' });
    expect(active.ok && active.value.map((t) => t.status)).toEqual(['active']);
    const bad = await facade.certificationTypes(anonymous(), { status: 'x' as never });
    expect(bad.ok).toBe(false);
  });
});
