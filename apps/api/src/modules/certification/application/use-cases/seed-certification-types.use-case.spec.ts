import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MIN_CLAIM_TERM_COMPACT_LENGTH } from '../../domain/type-revision';
import { matchClaimTerms, prepareVocabulary } from '../../domain/claim-text-matcher';
import { CheckedInTypeSeed } from '../../infrastructure/seed/checked-in-type-seed';
import type {
  CertificationTypeRepository,
  NewSeededType,
} from '../ports/certification-type.repository';
import type { SeededType } from '../ports/type-seed';
import { SeedCertificationTypes } from './seed-certification-types.use-case';

// The seed use case (certification design 5.2) in memory for both Market fixtures: system only,
// create-only, an existing code skipped whatever its revisions, a seed that breaks a revision
// rule refused before anything is written. The SQL is test/db/certification-seed.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class MemoryTypes implements CertificationTypeRepository {
  readonly byCode = new Map<string, NewSeededType>();
  existsByCode(_m: MarketContext, code: string): Promise<boolean> {
    return Promise.resolve(this.byCode.has(code));
  }
  addSeeded(_m: MarketContext, type: NewSeededType): Promise<void> {
    this.byCode.set(type.seeded.code, type);
    return Promise.resolve();
  }
}

const seed = new CheckedInTypeSeed();

describe.each(TEST_MARKETS)('SeedCertificationTypes in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = () => testCallContext(market, 'system', 'seed-certification-types-01');

  function build(types: readonly SeededType[] = seed.types(market)) {
    let sequence = 0;
    const repository = new MemoryTypes();
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const useCase = new SeedCertificationTypes(createUseCaseGate(markets, null), {
      unitOfWork,
      types: repository,
      seed: { types: () => types },
      supportedLocales: (m) => markets.get(m.marketId).supportedLocales,
      clock: new FixedClock(Temporal.Instant.from('2026-10-14T00:00:00Z')),
      ids: {
        next: <T extends string>() =>
          `01990000-0000-7000-8000-${String(++sequence).padStart(12, '0')}` as Id<T>,
      },
    });
    return { useCase, repository };
  }

  it('declares rule system under its own name', () => {
    expect(SeedCertificationTypes.access).toEqual({
      name: 'certification.seed-certification-types',
      rule: { kind: 'system' },
    });
  });

  it('has a seed for the Market that passes the revision rules, with terms for every type', () => {
    const types = seed.types(market);
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      const terms = Object.values(type.content.locales).flatMap((l) => l.claimTerms);
      expect(terms.length).toBeGreaterThan(0);
      for (const term of terms) {
        expect([...term.replace(/\s/g, '')].length).toBeGreaterThanOrEqual(
          MIN_CLAIM_TERM_COMPACT_LENGTH,
        );
      }
    }
  });

  it('creates every type once and nothing on a rerun', async () => {
    const s = build();
    const count = seed.types(market).length;
    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: count },
    });
    expect(s.repository.byCode.size).toBe(count);
    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: 0 },
    });
  });

  it('never rewrites a type that exists, whatever the seed now says', async () => {
    const [first] = seed.types(market);
    const s = build();
    const stored = { seeded: first } as NewSeededType;
    s.repository.byCode.set(first!.code, stored);
    await s.useCase.execute(system(), {});
    expect(s.repository.byCode.get(first!.code)).toBe(stored);
  });

  it('refuses a seed that breaks a revision rule, writing nothing, naming the type', async () => {
    const [first] = seed.types(market);
    const broken: SeededType = {
      ...first!,
      content: { ...first!.content, locales: {} },
    };
    const s = build([...seed.types(market).slice(1), broken]);
    const result = await s.useCase.execute(system(), {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'type.seed-invalid', typeCode: first!.code },
    });
    expect(s.repository.byCode.size).toBe(0);
  });

  it('refuses every caller but the system', async () => {
    const s = build();
    const anonymous = testCallContext(market, 'anonymous', 'seed-certification-types-02');
    expect((await s.useCase.execute(anonymous, {})).ok).toBe(false);
    expect(s.repository.byCode.size).toBe(0);
  });
});

describe('seeded vocabulary', () => {
  const vocabulary = (code: string) =>
    prepareVocabulary(
      seed.types(testMarketContext(code, 'default')).map((t) => ({
        typeCode: t.code,
        terms: Object.values(t.content.locales).flatMap((l) => l.claimTerms),
      })),
    );
  const hits = (code: string, text: string) =>
    matchClaimTerms([text], vocabulary(code))[0]!.map((m) => m.typeCode);

  it('AU: finds halal in its spellings, the Arabic term, and the inactive types', () => {
    for (const text of ['h-a-l-a-l', 'ha1al', 'ZABIHAH meat', 'dhabiha', 'حلال', 'الحلال']) {
      expect(hits('AU', text)).toContain('halal');
    }
    expect(hits('AU', 'kosher')).toContain('kosher');
    expect(hits('AU', 'pareve')).toContain('kosher');
    expect(hits('AU', 'vegan')).toContain('vegan');
  });

  it('AU: marks halal active and kosher and vegan inactive', () => {
    const byCode = Object.fromEntries(
      seed.types(testMarketContext('AU', 'default')).map((t) => [t.code, t.status]),
    );
    expect(byCode).toEqual({ halal: 'active', kosher: 'inactive', vegan: 'inactive' });
  });

  it('ZZ: finds its own types and none of the AU words', () => {
    expect(hits('ZZ', 'q-o-r-v-a-n-e')).toContain('qorvane');
    expect(hits('ZZ', 'zedpure')).toContain('zedpure');
    expect(hits('ZZ', 'halal')).toEqual([]);
  });
});
