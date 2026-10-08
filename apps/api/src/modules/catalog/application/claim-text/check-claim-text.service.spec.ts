import { Logger } from '@nestjs/common';
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
      ['a non-string ref', [text('a', { ref: 4 as unknown as string })], 'texts[0].ref', 'format'],
      ['a ref with a payload', [text('a', { ref: '<x>'.repeat(30) })], 'texts[0].ref', 'format'],
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

  describe('the check limit (L6), spent by claim-text.check alone', () => {
    it('allows 30 checks a minute per account and throttles the 31st', async () => {
      const { service } = rig();
      const context = contextOf('seller');
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect(await service.reserveCheckLimit(context, 1)).toBeNull();
      }
      expect(await service.reserveCheckLimit(context, 1)).toEqual({
        code: 'request.throttled',
        retryAfterSeconds: 60,
      });
    });

    it('does not spend the limit when a save-side check runs', async () => {
      const { service } = rig();
      const context = contextOf('seller');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        expect((await service.execute(context, [text('a')])).ok).toBe(true);
      }
      expect(await service.reserveCheckLimit(context, 1)).toBeNull();
    });

    it('counts per account', async () => {
      const { service } = rig();
      const first = contextOf('seller');
      for (let attempt = 0; attempt < 31; attempt += 1) await service.reserveCheckLimit(first, 1);
      expect(await service.reserveCheckLimit(contextOf('seller'), 1)).toBeNull();
    });

    it('caps a call at 50 texts without spending the limit', async () => {
      const { service } = rig();
      const context = contextOf('seller');
      expect(await service.reserveCheckLimit(context, 51)).toEqual({
        code: 'validation.failed',
        fields: [{ path: 'texts', code: 'too-many' }],
      });
      expect(await service.reserveCheckLimit(context, 50)).toBeNull();
    });

    it('is access.denied for a customer', async () => {
      const { service } = rig();
      expect(await service.reserveCheckLimit(contextOf('customer'), 1)).toEqual({
        code: 'access.denied',
      });
    });

    it('is access.unavailable, never a pass, when the counters cannot be reserved', async () => {
      const { service, store } = rig();
      store.down = true;
      expect(await service.reserveCheckLimit(contextOf('seller'), 1)).toEqual({
        code: 'access.unavailable',
      });
    });
  });

  describe('what the matcher may say', () => {
    const answerWith = (value: unknown) =>
      rig({ matcher: { match: () => Promise.resolve(ok(value as []) as Answer) } });

    it('passes on only the type code and the span, whatever else the matcher adds', async () => {
      const { service } = answerWith([
        [{ typeCode: 'type-a', term: 'secret', span: { fromToken: 1, toToken: 2, text: 'x' } }],
      ]);
      const result = await service.execute(contextOf('seller'), [text('a')]);
      expect(result.ok && result.value[0]).toMatchObject({
        code: 'claim-text.found',
        hits: [{ typeCode: 'type-a', span: { fromToken: 1, toToken: 2 } }],
      });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('"text":"x"');
    });

    it('passes a separator-removed hit with no span', async () => {
      const { service } = answerWith([[{ typeCode: 'type-a', span: null }]]);
      const result = await service.execute(contextOf('seller'), [text('a')]);
      expect(result.ok && result.value[0]).toMatchObject({ hits: [{ span: null }] });
    });

    it('passes several hits of several types', async () => {
      const hits = [
        { typeCode: 'type-a', span: { fromToken: 0, toToken: 0 } },
        { typeCode: 'type-b', span: null },
      ];
      const { service } = answerWith([hits]);
      const result = await service.execute(contextOf('seller'), [text('a')]);
      expect(result.ok && result.value[0]).toMatchObject({ hits });
    });

    it.each([
      ['an empty type code', [[{ typeCode: '', span: null }]]],
      ['an inverted span', [[{ typeCode: 'a', span: { fromToken: 3, toToken: 1 } }]]],
      ['a negative span', [[{ typeCode: 'a', span: { fromToken: -1, toToken: 1 } }]]],
      ['a list element that is not an array', [null]],
      [
        'more hits than a text can hold',
        [Array.from({ length: 101 }, () => ({ typeCode: 'a', span: null }))],
      ],
    ])('treats %s as unavailable', async (_name, value) => {
      const { service } = answerWith(value);
      const result = await service.execute(contextOf('seller'), [text('a')]);
      expect(result.ok && result.value[0]?.code).toBe('claim-text.check-unavailable');
    });

    it.each([
      [
        'a synchronous throw',
        () => {
          throw new Error('boom');
        },
      ],
      ['no Result at all', () => Promise.resolve(undefined)],
      ['null', () => Promise.resolve(null)],
    ])('treats %s as unavailable', async (_name, match) => {
      const { service } = rig({ matcher: { match } as unknown as ClaimTextMatcher });
      const result = await service.execute(contextOf('seller'), [text('a')]);
      expect(result.ok && result.value[0]?.code).toBe('claim-text.check-unavailable');
    });

    it('maps verdicts to the right texts across batches with hidden characters between', async () => {
      let call = 0;
      const { service } = rig({
        matcher: {
          match: (_c, texts) => {
            call += 1;
            if (call === 2) return Promise.reject(new Error('boom'));
            return Promise.resolve(ok(texts.map(() => [])));
          },
        },
      });
      const request = Array.from({ length: 205 }, (_, index) =>
        text(index % 50 === 0 ? `a\u202Eb${index}` : `t${index}`),
      );
      const result = await service.execute(contextOf('seller'), request);
      const codes = result.ok ? result.value.map((verdict) => verdict.code) : [];
      expect(codes).toHaveLength(205);
      request.forEach((item, index) => {
        if (item.text.includes('\u202E')) expect(codes[index]).toBe('text.invisible-character');
        else expect(['clean', 'claim-text.check-unavailable']).toContain(codes[index]);
      });
      expect(codes.filter((value) => value === 'claim-text.check-unavailable').length).toBe(100);
    });
  });

  describe('more hidden characters and boundaries', () => {
    it.each([
      ['a ZWJ in Latin', 'ab\u200Dcd', 'ZWJ', 2],
      ['a ZWNJ at the start', '\u200Cabc', 'ZWNJ', 0],
      ['a zero width space', 'ab\u200Bcd', 'other', 2],
      ['a byte order mark', 'ab\uFEFFcd', 'other', 2],
      ['a word joiner', 'ab\u2060cd', 'other', 2],
      ['a character after an astral one', '\u{1F600}x\u200Bz', 'other', 3],
    ])('refuses %s at its UTF-16 offset', async (_name, value, character, offset) => {
      const { service } = rig();
      const result = await service.execute(contextOf('seller'), [text(value)]);
      expect(result.ok && result.value[0]).toMatchObject({
        code: 'text.invisible-character',
        character,
        offset,
      });
    });

    it('accepts a ZWJ between Devanagari letters and keeps the text byte-identical', async () => {
      const { service, calls } = rig();
      const word = '\u0915\u094D\u200D\u0937';
      const result = await service.execute(contextOf('seller'), [text(word)]);
      expect(result.ok && result.value[0]?.code).toBe('clean');
      expect(calls[0]?.texts[0]?.text).toBe(word);
    });

    it('accepts exactly 500 texts and exactly 20,000 characters', async () => {
      const { service, calls } = rig();
      const many = Array.from({ length: MAX_CHECK_TEXTS }, () => text('a'));
      expect((await service.execute(contextOf('seller'), many)).ok).toBe(true);
      expect(calls).toHaveLength(5);
      expect((await service.execute(contextOf('seller'), [text('a'.repeat(20_000))])).ok).toBe(
        true,
      );
    });

    it('logs counts only, never a text', async () => {
      const logs: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((message: unknown) => void logs.push(JSON.stringify(message)));
      const { service } = rig();
      await service.execute(contextOf('seller'), [text('very secret halal words')]);
      spy.mockRestore();
      expect(logs.join('')).not.toContain('secret');
    });
  });
});
