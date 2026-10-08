import {
  testAuthenticatedActor,
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
let unusableVocabulary = false;
let emptyVocabulary: 'none' | 'no-entries' | 'no-terms' | 'one-empty' = 'none';
let leakyTypes = false;
const typesCalls: unknown[] = [];
const reader: PublishedTypesReader = {
  claimVocabulary: (market) => {
    if (failing) return Promise.reject(new Error('db down'));
    // A term with no matchable content: prepareVocabulary throws on it.
    if (emptyVocabulary === 'no-entries') return Promise.resolve([]);
    if (emptyVocabulary === 'no-terms') {
      return Promise.resolve([{ typeCode: code('halal'), terms: [] }]);
    }
    if (emptyVocabulary === 'one-empty') {
      return Promise.resolve([
        { typeCode: code('halal'), terms: [] },
        { typeCode: code('kosher'), terms: ['kosher'] },
      ]);
    }
    if (unusableVocabulary) return Promise.resolve([{ typeCode: code('x'), terms: [' - '] }]);
    return Promise.resolve(VOCAB[market.marketId] ?? []);
  },
  types: (market, filter) => {
    typesCalls.push([market.marketId, filter]);
    if (failing) return Promise.reject(new Error('db down'));
    const all = [
      typeView(`a-${market.marketId.toLowerCase()}`, 'active'),
      typeView('b-off', 'inactive'),
    ];
    const picked = filter.status ? all.filter((t) => t.status === filter.status) : all;
    return Promise.resolve(
      leakyTypes
        ? picked.map((t) => ({ ...t, claimTerms: ['halal'] }) as CertificationTypeView)
        : picked,
    );
  },
};

describe.each(['AU', 'ZZ'])('certification facade reads, Market %s', (marketCode) => {
  const market = () => testMarketContext(marketCode, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const system = () => testCallContext(market(), 'system');
  const facade = new CertificationFacadeImplementation({
    evaluateClaims: undefined as never,
    evaluateClaimsSystem: undefined as never,
    matchClaimTerms: new MatchClaimTerms(gate, reader),
    matchClaimTermsSystem: new MatchClaimTermsSystem(gate, reader),
    certificationTypes: new CertificationTypes(gate, reader),
    certificationTypesSystem: new CertificationTypesSystem(gate, reader),
  });
  const own = marketCode === 'AU' ? 'halal' : 'зед чисто';
  const other = marketCode === 'AU' ? 'зед чисто' : 'halal';

  const request = new MatchClaimTerms(gate, reader);
  const jobs = new MatchClaimTermsSystem(gate, reader);
  const typesRequest = new CertificationTypes(gate, reader);
  const typesJobs = new CertificationTypesSystem(gate, reader);
  const person = (population: 'seller' | 'admin') =>
    testAuthenticatedActor(market(), {
      population,
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
    });

  beforeEach(() => {
    failing = false;
    unusableVocabulary = false;
    emptyVocabulary = 'none';
    leakyTypes = false;
    typesCalls.length = 0;
  });

  it('gates the pair: the system use cases refuse every other actor, the request ones serve every kind', async () => {
    const texts = [{ locale: 'en', text: own }];
    for (const actor of ['anonymous', person('seller'), person('admin')] as const) {
      const denied = await jobs.execute(testCallContext(market(), actor), { texts });
      expect(denied.ok).toBe(false);
      const deniedTypes = await typesJobs.execute(testCallContext(market(), actor), { filter: {} });
      expect(deniedTypes.ok).toBe(false);
    }
    const answers: string[] = [];
    for (const actor of ['anonymous', person('seller'), person('admin')] as const) {
      const r = await request.execute(testCallContext(market(), actor), { texts });
      const t = await typesRequest.execute(testCallContext(market(), actor), { filter: {} });
      expect(r.ok && t.ok).toBe(true);
      answers.push(JSON.stringify([r, t.ok ? t.value.map((v) => v.code) : null]));
    }
    expect(new Set(answers).size).toBe(1);
    // The request use cases refuse the system actor: the facade must pick the other one.
    const wrong = await request.execute(system(), { texts });
    expect(wrong).toEqual({ ok: false, error: { code: 'access.denied' } });
    const wrongTypes = await typesRequest.execute(system(), { filter: {} });
    expect(wrongTypes).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect((await jobs.execute(system(), { texts })).ok).toBe(true);
  });

  it('is unavailable when the Market has no types, or any type has no terms (missing seed, reader fault)', async () => {
    for (const mode of ['no-entries', 'no-terms', 'one-empty'] as const) {
      emptyVocabulary = mode;
      const r = await facade.matchClaimTerms(system(), [{ locale: 'en', text: own }]);
      expect(r).toEqual({ ok: false, error: { code: 'certification.unavailable' } });
    }
  });

  it('refuses text that NFKC expands past the cap, as a length problem and not as unavailable', async () => {
    const r = await facade.matchClaimTerms(anonymous(), [{ locale: 'en', text: 'ﷺ'.repeat(1200) }]);
    expect(r).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'texts.0.text', code: 'length' }] },
    });
  });

  it('answers once per text even when the array has its own entries method, reading getters once', async () => {
    const odd = [{ locale: 'en', text: own }] as unknown as { entries: () => unknown }[];
    odd.entries = function* () {} as never;
    const r = await facade.matchClaimTerms(anonymous(), odd as never);
    expect(r.ok && r.value.length).toBe(1);
    let reads = 0;
    const getter = {
      locale: 'en',
      get text() {
        reads += 1;
        return reads === 1 ? 'ok' : 'a'.repeat(5_000_000);
      },
    };
    const g = await facade.matchClaimTerms(anonymous(), [getter]);
    expect(reads).toBe(1);
    expect(g.ok).toBe(true);
  });

  it('hands out only the contract keys of a type, whatever the reader returns', async () => {
    leakyTypes = true;
    const r = await facade.certificationTypes(anonymous(), {});
    expect(r.ok && r.value.every((t) => !('claimTerms' in t))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('halal');
  });

  it('is unavailable when the vocabulary cannot be used by the matcher', async () => {
    unusableVocabulary = true;
    const r = await facade.matchClaimTerms(anonymous(), [{ locale: 'en', text: own }]);
    expect(r).toEqual({ ok: false, error: { code: 'certification.unavailable' } });
  });

  it('accepts exactly 20000 characters and refuses a mixed list whole, with the field named', async () => {
    const ok20k = await facade.matchClaimTerms(anonymous(), [
      { locale: 'en', text: 'a'.repeat(20_000) },
    ]);
    expect(ok20k.ok).toBe(true);
    const empty = await facade.matchClaimTerms(anonymous(), [{ locale: 'en', text: '' }]);
    expect(empty).toEqual({ ok: true, value: [[]] });
    failing = true;
    const mixed = await facade.matchClaimTerms(anonymous(), [
      { locale: 'en', text: own },
      { locale: 'en', text: 'a'.repeat(20_001) },
    ]);
    expect(mixed).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'texts.1.text', code: 'length' }] },
    });
  });

  it('passes the type view through unchanged, with the right Market and filter', async () => {
    const a = await facade.certificationTypes(anonymous(), {});
    const s = await facade.certificationTypes(system(), {});
    expect(a.ok && s.ok).toBe(true);
    if (!a.ok || !s.ok) return;
    expect(a.value.map((t) => ({ ...t, publishedRevisionId: 'x' }))).toEqual(
      s.value.map((t) => ({ ...t, publishedRevisionId: 'x' })),
    );
    expect(a.value[0]).toEqual(
      expect.objectContaining({
        code: `a-${marketCode.toLowerCase()}`,
        status: 'active',
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresIssuerRegistry: true,
        requiresDocument: true,
        requiresExpiry: true,
        defaultBasis: 'SELLER_REQUIRED',
        autoApproveSelfDeclaration: false,
        badgeIconKey: 'seal',
        locales: {
          en: {
            name: `a-${marketCode.toLowerCase()}`,
            customerDescription: `a-${marketCode.toLowerCase()}`,
          },
        },
      }),
    );
    expect(a.value[0]).not.toHaveProperty('claimTerms');
    expect(typesCalls[0]).toEqual([marketCode, {}]);
    const inactive = await facade.certificationTypes(anonymous(), { status: 'inactive' });
    expect(inactive.ok && inactive.value.map((t) => t.code)).toEqual(['b-off']);
    expect(typesCalls[2]).toEqual([marketCode, { status: 'inactive' }]);
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
