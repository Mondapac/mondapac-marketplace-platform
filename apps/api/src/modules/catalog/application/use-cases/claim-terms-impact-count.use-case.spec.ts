import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AccessDeclaration, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import type { RateReservation } from '../../domain/rate-limits';
import type {
  CandidateMatchFailure,
  CandidateTerms,
  ClaimTermsCandidateMatcher,
} from '../ports/claim-terms-candidate-matcher';
import type {
  ClaimTextImpactReader,
  ImpactTextKind,
  ImpactTextRow,
} from '../ports/claim-text-impact.reader';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';
import {
  ClaimTermsImpactCount,
  IMPACT_COUNT_MAX_TEXTS,
  IMPACT_COUNT_PAGE_ROWS,
} from './claim-terms-impact-count.use-case';

// `claim-terms.impact-count` in memory (catalog design 6.5, request C-7), on both Market
// fixtures: the use case with a fake reader, a fake matcher that finds the word "zorbex", an
// advancing clock and counters that remember. The Prisma reader has no raw SQL.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-22T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('claim-terms impact count in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const locale = policy.locales(market).default;
  const body = { typeCode: 'zorbex', termsByLocale: { [locale]: ['zorbex'] } };

  const admin = (actingAs = false): CallContext => {
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    return actingAs
      ? ({
          ...context,
          actor: { ...context.actor, actingAs: { adminAccountId: 'x', sellerId: 'y' } },
        } as unknown as CallContext)
      : context;
  };
  const seller = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );

  /** Rows of one kind: `matching` of every `of` rows carry the word; each has `texts` texts. */
  const rowsOf = (n: number, matching: number, texts = 1): ImpactTextRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: ids.next(),
      texts: Array.from({ length: texts }, (_, t) => ({
        locale,
        text: i < matching && t === 0 ? 'our Zorbex oats' : 'plain oats',
      })),
    }));

  function rig(
    options: {
      products?: ImpactTextRow[];
      offers?: ImpactTextRow[];
      matcherFails?: CandidateMatchFailure;
      matcherThrowsAfter?: number;
      readerFails?: boolean;
      tickPerPage?: Temporal.Duration;
      allow?: boolean;
    } = {},
  ) {
    const clock = new FixedClock(T0);
    const checked: AccessDeclaration[] = [];
    const check: AuthorisationCheck = {
      check: (_c, declaration) => {
        checked.push(declaration);
        return Promise.resolve(
          options.allow === false
            ? { allowed: false, denial: { code: 'access.denied' } }
            : { allowed: true },
        );
      },
    };
    const open = { depth: 0, maxDepth: 0, units: [] as (UnitOfWorkOptions | undefined)[] };
    const unitOfWork = {
      run: async <T, E>(
        _m: MarketContext,
        work: () => Promise<Result<T, E>>,
        o?: UnitOfWorkOptions,
      ) => {
        open.units.push(o);
        open.depth += 1;
        open.maxDepth = Math.max(open.maxDepth, open.depth);
        try {
          return await work();
        } finally {
          open.depth -= 1;
        }
      },
    } as unknown as UnitOfWork;
    const data: Record<ImpactTextKind, ImpactTextRow[]> = {
      product: options.products ?? [],
      offer: options.offers ?? [],
    };
    const pages: { kind: ImpactTextKind; afterId: string | null }[] = [];
    const reader: ClaimTextImpactReader = {
      page: (_m, query) => {
        if (options.readerFails === true) return Promise.reject(new Error('db down'));
        pages.push({ kind: query.kind, afterId: query.afterId });
        if (options.tickPerPage !== undefined) clock.advance(options.tickPerPage);
        const all = data[query.kind];
        const start =
          query.afterId === null ? 0 : all.findIndex((row) => row.id === query.afterId) + 1;
        const rows = all.slice(start, start + query.limit);
        return Promise.resolve({
          rows,
          nextAfterId: rows.length < query.limit ? null : rows[rows.length - 1]!.id,
        });
      },
    };
    const calls: { context: CallContext; candidate: CandidateTerms; size: number }[] = [];
    const matcher: ClaimTermsCandidateMatcher = {
      matches: (context, candidate, texts) => {
        // The facade must be called with no unit open (units do not nest).
        expect(open.depth).toBe(0);
        calls.push({ context, candidate, size: texts.length });
        if (options.matcherFails !== undefined) return Promise.resolve(err(options.matcherFails));
        if (options.matcherThrowsAfter !== undefined && calls.length > options.matcherThrowsAfter) {
          return Promise.resolve(err({ code: 'claim-text.check-unavailable' } as const));
        }
        return Promise.resolve(ok(texts.map((t) => t.text.toLowerCase().includes('zorbex'))));
      },
    };
    const counters = new Map<string, number>();
    const counterRepo: RateCounterRepository = {
      reserve: (_m, wanted: readonly RateCounter[], now) =>
        Promise.resolve(
          wanted.map((c): RateReservation => {
            const key = `${c.limit.kind}:${Buffer.from(c.keyHash).toString('hex')}`;
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            return { kind: c.limit.kind, count, windowStartedAt: now };
          }),
        ),
      purgeStartedBefore: () => Promise.resolve(0),
    };
    const useCase = new ClaimTermsImpactCount(createUseCaseGate(markets, check), {
      unitOfWork,
      impactReader: reader,
      candidateMatcher: matcher,
      counters: counterRepo,
      counterKeys: new HmacRateCounterKeys(Buffer.alloc(32, 7)),
      policy,
      clock,
    });
    return { useCase, checked, open, pages, calls, clock };
  }

  it('counts matching published products and Offers, batching 100 texts a call, read-only units closed before each call', async () => {
    const { useCase, open, calls, checked } = rig({
      products: rowsOf(120, 30, 2), // 240 texts: 3 calls
      offers: rowsOf(10, 4),
    });
    const r = await useCase.execute(admin(), { body });
    expect(r).toEqual({ ok: true, value: { products: 30, offers: 4, total: 34, complete: true } });
    expect(checked[0]!.rule).toEqual({ kind: 'permissions', allOf: ['certification.type.edit'] });
    // The probe, then ceil(page texts / 100) calls per page.
    expect(Math.max(...calls.map((c) => c.size))).toBeLessThanOrEqual(100);
    expect(calls[0]!.size).toBe(1);
    expect(calls.every((c) => c.candidate.typeCode === 'zorbex')).toBe(true);
    expect(open.maxDepth).toBe(1);
    expect(open.units.filter((o) => o?.readOnly === true).length).toBeGreaterThan(0);
  });

  it('counts a product once however many of its texts match', async () => {
    const products: ImpactTextRow[] = [
      { id: ids.next(), texts: [1, 2, 3].map(() => ({ locale, text: 'zorbex zorbex' })) },
    ];
    const r = await rig({ products }).useCase.execute(admin(), { body });
    expect(r.ok && r.value).toEqual({ products: 1, offers: 0, total: 1, complete: true });
  });

  it('answers zero and complete for a Market with nothing published, after the terms were checked', async () => {
    const { useCase, calls } = rig();
    const r = await useCase.execute(admin(), { body });
    expect(r).toEqual({ ok: true, value: { products: 0, offers: 0, total: 0, complete: true } });
    expect(calls).toHaveLength(1); // the probe: certification validated the candidate
  });

  it('stops at 20,000 texts with complete=false and the count so far', async () => {
    const rowsNeeded = IMPACT_COUNT_MAX_TEXTS / 2 + 100;
    const { useCase } = rig({ products: rowsOf(rowsNeeded, rowsNeeded, 2), offers: rowsOf(5, 5) });
    const r = await useCase.execute(admin(), { body });
    expect(r.ok && r.value.complete).toBe(false);
    expect(r.ok && r.value.products).toBe(IMPACT_COUNT_MAX_TEXTS / 2);
    expect(r.ok && r.value.offers).toBe(0);
  });

  it('stops at 10 seconds of the injected clock with complete=false', async () => {
    const products = rowsOf(IMPACT_COUNT_PAGE_ROWS * 30, IMPACT_COUNT_PAGE_ROWS * 30);
    const { useCase, pages } = rig({
      products,
      tickPerPage: Temporal.Duration.from({ seconds: 4 }),
    });
    const r = await useCase.execute(admin(), { body });
    expect(r.ok && r.value.complete).toBe(false);
    expect(pages.length).toBe(3); // 4 s a page: the third page is read at 12 s
    // The third page is past the deadline before its first matcher call, so it is not counted.
    expect(r.ok && r.value.products).toBe(IMPACT_COUNT_PAGE_ROWS * 2);
  });

  it('is unavailable, never zero, when the matcher cannot answer (first call or later)', async () => {
    const first = await rig({
      products: rowsOf(3, 3),
      matcherFails: { code: 'claim-text.check-unavailable' },
    }).useCase.execute(admin(), { body });
    expect(first).toEqual({ ok: false, error: { code: 'claim-text.check-unavailable' } });
    const later = await rig({
      products: rowsOf(3, 3),
      matcherThrowsAfter: 1,
    }).useCase.execute(admin(), { body });
    expect(later).toEqual({ ok: false, error: { code: 'claim-text.check-unavailable' } });
  });

  it('passes on a refusal of the candidate terms as validation.failed', async () => {
    const fields = [{ path: `termsByLocale.${locale}`, code: 'unmatchable' }];
    const r = await rig({
      matcherFails: { code: 'validation.failed', fields },
    }).useCase.execute(admin(), { body });
    expect(r).toEqual({ ok: false, error: { code: 'validation.failed', fields } });
  });

  it('is access.unavailable when the published texts cannot be read', async () => {
    const r = await rig({ readerFails: true }).useCase.execute(admin(), { body });
    expect(r).toEqual({ ok: false, error: { code: 'access.unavailable' } });
  });

  it('refuses a malformed body before any read', async () => {
    const { useCase, calls, pages } = rig();
    for (const bad of [
      null,
      [],
      {},
      { termsByLocale: [] },
      { termsByLocale: { [locale]: 'zorbex' } },
      { termsByLocale: { [locale]: [1] } },
      { typeCode: 5, termsByLocale: { [locale]: ['zorbex'] } },
      { termsByLocale: { [locale]: ['zorbex'] }, extra: true },
    ]) {
      const r = await useCase.execute(admin(), { body: bad });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe('validation.failed');
    }
    expect(calls).toHaveLength(0);
    expect(pages).toHaveLength(0);
  });

  it('refuses a seller, a non-holder and an acting-as session, and reads nothing', async () => {
    for (const [context, allow] of [
      [seller(), true],
      [admin(), false],
      [admin(true), true],
    ] as const) {
      const { useCase, calls, pages } = rig({ allow, products: rowsOf(3, 3) });
      const r = await useCase.execute(context, { body });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe('access.denied');
      expect(calls).toHaveLength(0);
      expect(pages).toHaveLength(0);
    }
  });

  it('throttles an account that has spent its claim-text check budget (30 a minute)', async () => {
    const { useCase } = rig();
    const context = admin();
    for (let call = 0; call < 30; call += 1) {
      expect((await useCase.execute(context, { body })).ok).toBe(true);
    }
    const r = await useCase.execute(context, { body });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('request.throttled');
  });
});
