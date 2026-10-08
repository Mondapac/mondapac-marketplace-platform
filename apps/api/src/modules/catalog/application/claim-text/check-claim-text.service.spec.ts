import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { RateReservation } from '../../domain/rate-limits';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { UnavailableClaimTextMatcher } from '../../infrastructure/placeholders/unavailable-claim-text-matcher';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  ClaimTextCheckUnavailable,
  ClaimTextMatch,
  ClaimTextMatcher,
  ClaimTextToMatch,
} from '../ports/claim-text-matcher';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';
import { CheckClaimText, MAX_CHECK_TEXTS, type CheckedText } from './check-claim-text.service';

// CheckClaimText (catalog design 6.1, 6.3, 6.6; slice 5) over in-memory ports, for both Market
// fixtures: fail-closed on every matcher fault, hidden characters refused before matching, the
// check limit reserved first, the request validated as a whole, no text echoed.

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] } },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] } },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const HIT: ClaimTextMatch = { typeCode: 'type-a', span: { fromToken: 0, toToken: 1 } };

describe.each(FIXTURES)('CheckClaimText in market $code', ({ code, locales }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const locale = locales.default;

  const contextOf = (
    population: 'seller' | 'admin' | 'customer',
    sellerId = population === 'seller' ? ids.next<'Seller'>() : null,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );

  const text = (value: string, overrides: Partial<CheckedText> = {}): CheckedText => ({
    field: 'product.name',
    ref: null,
    locale,
    text: value,
    ...overrides,
  });

  type Answer = Result<readonly (readonly ClaimTextMatch[])[], ClaimTextCheckUnavailable>;

  function rig(options: { matcher?: ClaimTextMatcher; policyThrows?: boolean } = {}) {
    const calls: { context: CallContext; texts: readonly ClaimTextToMatch[] }[] = [];
    const counters = new Map<string, number>();
    const store = { down: false };
    const defaultMatcher: ClaimTextMatcher = {
      match: (context, texts) => {
        calls.push({ context, texts });
        return Promise.resolve(
          ok(texts.map((item) => (item.text.includes('halal') ? [HIT] : []))) as Answer,
        );
      },
    };
    const matcher: ClaimTextMatcher = options.matcher ?? defaultMatcher;
    const wrapped: ClaimTextMatcher = {
      match: (context, texts) => {
        if (options.matcher !== undefined) calls.push({ context, texts });
        return matcher.match(context, texts);
      },
    };
    const counterRepo: RateCounterRepository = {
      reserve: (_m, wanted: readonly RateCounter[], now) => {
        if (store.down) return Promise.reject(new Error('store down'));
        return Promise.resolve(
          wanted.map((counter): RateReservation => {
            const key = `${counter.limit.kind}:${Buffer.from(counter.keyHash).toString('hex')}`;
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            return { kind: counter.limit.kind, count, windowStartedAt: now };
          }),
        );
      },
      purgeStartedBefore: () => Promise.resolve(0),
    };
    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => [],
      locales: () => {
        if (options.policyThrows === true) throw new Error('policy down');
        return { default: locales.default, supported: [...locales.supported] };
      },
      sensitiveChanges: () => {
        throw new Error('not used');
      },
      maxVariantsPerProduct: () => 1,
      approvalRequired: () => Promise.resolve(true),
    };
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const service = new CheckClaimText({
      unitOfWork,
      matcher: wrapped,
      counters: counterRepo,
      counterKeys: new HmacRateCounterKeys(Buffer.alloc(32, 7)),
      policy,
      clock,
    });
    return { service, calls, store };
  }

  it('answers one verdict per text, in order, with the place and never the text', async () => {
    const { service, calls } = rig();
    const context = contextOf('seller');
    const result = await service.execute(context, [
      text('fresh dates'),
      text('halal dates', { field: 'product.variant-label', ref: 'variant-1' }),
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        { code: 'clean', field: 'product.name', ref: null, locale },
        {
          code: 'claim-text.found',
          field: 'product.variant-label',
          ref: 'variant-1',
          locale,
          hits: [HIT],
        },
      ],
    });
    // The matcher is called with the caller's own context, unchanged (R3).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toBe(context);
  });

  it('serves an admin and an empty request', async () => {
    const { service, calls } = rig();
    await expect(service.execute(contextOf('admin'), [])).resolves.toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(0);
  });

  it.each(['customer'] as const)('refuses a %s actor', async (population) => {
    const { service, calls } = rig();
    await expect(service.execute(contextOf(population), [text('a')])).resolves.toEqual(
      err({ code: 'access.denied' }),
    );
    expect(calls).toHaveLength(0);
  });

  describe('hidden characters (6.3)', () => {
    it('refuses a bidi control before matching and reports its place', async () => {
      const { service, calls } = rig();
      const result = await service.execute(contextOf('seller'), [text('ab‮cd'), text('ok')]);
      expect(result).toEqual({
        ok: true,
        value: [
          {
            code: 'text.invisible-character',
            offset: 2,
            character: 'other',
            field: 'product.name',
            ref: null,
            locale,
          },
          { code: 'clean', field: 'product.name', ref: null, locale },
        ],
      });
      expect(calls[0]?.texts).toEqual([{ locale, text: 'ok' }]);
    });

    it('refuses a ZWNJ outside a joining script', async () => {
      const { service } = rig();
      const result = await service.execute(contextOf('seller'), [text('ab‌cd')]);
      expect(result.ok && result.value[0]).toMatchObject({
        code: 'text.invisible-character',
        character: 'ZWNJ',
        offset: 2,
      });
    });

    it('lets a ZWNJ between Arabic letters through to the matcher', async () => {
      const { service, calls } = rig();
      const word = 'می‌خواهم';
      const result = await service.execute(contextOf('seller'), [text(word, { locale: 'en' })]);
      expect(result.ok && result.value[0]?.code).toBe('clean');
      expect(calls[0]?.texts).toEqual([{ locale: 'en', text: word }]);
    });
  });

  describe('fail closed (M8)', () => {
    const unavailable = (field = 'product.name') => ({
      code: 'claim-text.check-unavailable',
      field,
      ref: null,
      locale,
    });

    it('marks every text unavailable under the placeholder', async () => {
      const { service } = rig({ matcher: new UnavailableClaimTextMatcher() });
      const result = await service.execute(contextOf('seller'), [text('a'), text('b')]);
      expect(result).toEqual({ ok: true, value: [unavailable(), unavailable()] });
    });

    it('treats a throwing matcher as unavailable', async () => {
      const { service } = rig({
        matcher: { match: () => Promise.reject(new Error('boom')) },
      });
      const result = await service.execute(contextOf('seller'), [text('a')]);
      expect(result).toEqual({ ok: true, value: [unavailable()] });
    });

    it.each([
      ['an answer of the wrong length', ok([]) as Answer],
      ['a non-array answer', ok(null as unknown as []) as Answer],
      ['a malformed match', ok([[{ typeCode: 7 }]] as unknown as []) as Answer],
      [
        'a malformed span',
        ok([[{ typeCode: 'a', span: { fromToken: 'x' } }]] as unknown as []) as Answer,
      ],
    ])('treats %s as unavailable', async (_name, answer) => {
      const { service } = rig({ matcher: { match: () => Promise.resolve(answer) } });
      const result = await service.execute(contextOf('seller'), [text('a')]);
      expect(result).toEqual({ ok: true, value: [unavailable()] });
    });

    it('lets a hidden character win over an unavailable matcher', async () => {
      const { service } = rig({ matcher: new UnavailableClaimTextMatcher() });
      const result = await service.execute(contextOf('seller'), [text('a‮b')]);
      expect(result.ok && result.value[0]?.code).toBe('text.invisible-character');
    });

    it('keeps a failing batch from spoiling the others', async () => {
      let call = 0;
      const { service, calls } = rig({
        matcher: {
          match: (_c, texts) => {
            call += 1;
            return Promise.resolve(
              call === 2
                ? err({ code: 'claim-text.check-unavailable' as const })
                : ok(texts.map(() => [])),
            );
          },
        },
      });
      const request = Array.from({ length: 250 }, (_, index) => text(`t${index}`));
      const result = await service.execute(contextOf('seller'), request);
      expect(calls.map((entry) => entry.texts.length)).toEqual([100, 100, 50]);
      const codes = result.ok ? result.value.map((verdict) => verdict.code) : [];
      expect(codes.slice(0, 100).every((value) => value === 'clean')).toBe(true);
      expect(codes.slice(100, 200).every((value) => value === 'claim-text.check-unavailable')).toBe(
        true,
      );
      expect(codes.slice(200).every((value) => value === 'clean')).toBe(true);
    });
  });

  describe('the request as a whole', () => {
    it.each([
      [
        'an unregistered field',
        [text('a', { field: 'product.sku' as never })],
        'texts[0].field',
        'unknown',
      ],
      ['an unsupported locale', [text('a', { locale: 'fr' })], 'texts[0].locale', 'unsupported'],
      ['a too long text', [text('a'.repeat(20_001))], 'texts[0].text', 'too-long'],
      ['a non-string text', [text(7 as unknown as string)], 'texts[0].text', 'type'],
      ['a non-string ref', [text('a', { ref: 4 as unknown as string })], 'texts[0].ref', 'type'],
      ['a non-object item', [null as unknown as CheckedText], 'texts[0]', 'type'],
    ])('refuses %s with a fixed path', async (_name, request, path, reason) => {
      const { service, calls } = rig();
      const result = await service.execute(contextOf('seller'), request);
      expect(result).toEqual(err({ code: 'validation.failed', fields: [{ path, code: reason }] }));
      expect(calls).toHaveLength(0);
    });

    it('refuses more than the most texts and a non-array', async () => {
      const { service } = rig();
      const many = Array.from({ length: MAX_CHECK_TEXTS + 1 }, () => text('a'));
      await expect(service.execute(contextOf('seller'), many)).resolves.toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'texts', code: 'too-many' }] }),
      );
      await expect(
        service.execute(contextOf('seller'), 'x' as unknown as CheckedText[]),
      ).resolves.toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'texts', code: 'type' }] }),
      );
    });

    it('is access.unavailable when the Market policy cannot answer', async () => {
      const { service } = rig({ policyThrows: true });
      await expect(service.execute(contextOf('seller'), [text('a')])).resolves.toEqual(
        err({ code: 'access.unavailable' }),
      );
    });
  });

  describe('the check limit (L6)', () => {
    it('allows 30 checks a minute per account and throttles the 31st', async () => {
      const { service, calls } = rig();
      const context = contextOf('seller');
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await service.execute(context, [text('a')])).ok).toBe(true);
      }
      const refused = await service.execute(context, [text('a')]);
      expect(refused).toEqual(err({ code: 'request.throttled', retryAfterSeconds: 60 }));
      expect(calls).toHaveLength(30);
    });

    it('counts per account', async () => {
      const { service } = rig();
      const first = contextOf('seller');
      for (let attempt = 0; attempt < 31; attempt += 1) await service.execute(first, [text('a')]);
      expect((await service.execute(contextOf('seller'), [text('a')])).ok).toBe(true);
    });

    it('is access.unavailable, never a pass, when the counters cannot be reserved', async () => {
      const { service, calls, store } = rig();
      store.down = true;
      await expect(service.execute(contextOf('seller'), [text('a')])).resolves.toEqual(
        err({ code: 'access.unavailable' }),
      );
      expect(calls).toHaveLength(0);
    });
  });
});
