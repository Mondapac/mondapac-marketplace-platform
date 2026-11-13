import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { WRITER_EVALUATION_SET } from '../../domain/description-writer/evaluation-set';
import type { RateReservation } from '../../domain/rate-limits';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type {
  DescriptionWriterModel,
  MarketDayCalendar,
  WriterModelAnswer,
  WriterModelTier,
} from '../ports/description-writer';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import {
  type DescriptionWriterDependencies,
  writeDescriptionDraft,
  writerAvailability,
} from './description-writer.flow';

// The AI description writer end to end against a fake provider (ADR-0019 decision 9), on both
// Market fixtures: the recorded request holds the allow-listed fields only and no canary; the
// seller and the Market come from the context, never the body; counters are per seller and per
// Market; injected text and claim words never reach the answer; and every non-AI path ends
// cleanly (writer off, kill switch, timeout, early stop, limit reached, matcher down, acting-as).

const T0 = Temporal.Instant.from('2026-11-13T10:00:00Z');
const MIDNIGHT = Temporal.Instant.from('2026-11-13T14:00:00Z');
const SELLER = '01990000-0000-7000-8000-0000000000b1' as Id<'Seller'>;
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000b2' as Id<'Seller'>;
const SELLER_ACCOUNT = '01990000-0000-7000-8000-0000000000c1' as Id<'Account'>;
const OTHER_ACCOUNT = '01990000-0000-7000-8000-0000000000c2' as Id<'Account'>;
const ADMIN = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const CANARY_SESSION = '01990000-0000-7000-8000-00000000ca11' as never;

const BODY = {
  title: 'Sella basmati rice',
  category: 'Basmati rice',
  details: [{ name: 'Brand', value: 'Tilda' }],
  keywords: ['biryani'],
  note: 'Cooks in 15 minutes.',
  tone: 'warm',
  length: 50,
};

describe.each(['AU', 'ZZ'] as const)('description writer in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const zone = code === 'AU' ? 'Australia/Brisbane' : 'Etc/UTC';

  const sellerContext = (sellerId = SELLER, accountId = SELLER_ACCOUNT): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: CANARY_SESSION,
        sellerId,
      }),
    );
  const adminContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: CANARY_SESSION,
        sellerId: null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = sellerContext();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let requests: { market: MarketContext; tier: WriterModelTier; system: string; input: string }[];
  let answer: WriterModelAnswer;
  let configured: boolean;
  let marketSwitch: { enabled: boolean; tier: WriterModelTier } | 'throws';
  let sellerSwitch: Map<string, boolean>;
  let counts: Map<string, number>;
  let preset: Map<string, number>;
  let matcherState: 'up' | 'down' | 'throws' | 'short';
  let matched: string[][];

  const model: DescriptionWriterModel = {
    configured: () => configured,
    setup: () => ({
      killSwitch: false,
      keyConfigured: true,
      models: { fast: 'm-fast', balanced: 'm-balanced' },
    }),
    write: (m, tier, request) => {
      requests.push({ market: m, tier, system: request.system, input: request.input });
      return Promise.resolve(answer);
    },
  };
  const switches = {
    market: () =>
      marketSwitch === 'throws'
        ? Promise.reject(new Error('settings down'))
        : Promise.resolve(marketSwitch),
    seller: (_c: CallContext, sellerId: Id<'Seller'>) =>
      Promise.resolve(sellerSwitch.get(sellerId) === true),
  };
  const calendar: MarketDayCalendar = {
    dayOf: () => '2026-11-13',
    nextMidnight: () => MIDNIGHT,
    zoneOf: () => zone,
  };
  // The key spells out what it hashes, so a test can see whose counter moved.
  const counterKeys = {
    keyOf: (m: MarketContext, kind: string, subject: string) =>
      new TextEncoder().encode(`${m.marketId}|${kind}|${subject}`),
  };
  const counters = {
    reserve: (
      _m: MarketContext,
      asked: readonly { limit: { kind: string }; keyHash: Uint8Array }[],
      now: Temporal.Instant,
    ): Promise<readonly RateReservation[]> =>
      Promise.resolve(
        asked.map((counter) => {
          const key = new TextDecoder().decode(counter.keyHash);
          const count = (counts.get(key) ?? preset.get(counter.limit.kind) ?? 0) + 1;
          counts.set(key, count);
          return { kind: counter.limit.kind, count, windowStartedAt: now } as RateReservation;
        }),
      ),
  } as unknown as RateCounterRepository;
  // The Market's vocabulary: a term the guard's own lists do not hold.
  const matcher: ClaimTextMatcher = {
    match: (_c, texts) => {
      matched.push(texts.map((t) => t.text));
      if (matcherState === 'throws') return Promise.reject(new Error('down'));
      if (matcherState === 'down') return Promise.resolve(err({ code: 'claim-text.check-unavailable' }));
      const lists = texts.map((t) =>
        /tayyib/iu.test(t.text) ? [{ typeCode: 'tayyib', span: null }] : [],
      );
      return Promise.resolve(ok(matcherState === 'short' ? lists.slice(1) : lists));
    },
  };
  const deps = (): DescriptionWriterDependencies => ({
    unitOfWork: {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as never,
    counters,
    counterKeys: counterKeys as never,
    clock: new FixedClock(T0),
    matcher,
    model,
    switches,
    calendar,
  });

  beforeEach(() => {
    requests = [];
    answer = { ok: true, text: 'Tilda Sella basmati cooks in 15 minutes.\n\nGood for biryani.' };
    configured = true;
    marketSwitch = { enabled: true, tier: 'fast' };
    sellerSwitch = new Map([
      [SELLER, true],
      [OTHER_SELLER, true],
    ]);
    counts = new Map();
    preset = new Map();
    matcherState = 'up';
    matched = [];
  });

  const write = (context: CallContext, body: unknown = BODY, kind: 'seller' | 'admin' = 'seller') =>
    writeDescriptionDraft(deps(), context, kind, body);

  it('writes a draft for a seller and keeps the paragraphs', async () => {
    const result = await write(sellerContext());
    expect(result).toEqual(
      ok({
        text: 'Tilda Sella basmati cooks in 15 minutes.\n\nGood for biryani.',
        leftOut: { certification: 0, other: 0 },
        promptVersion: 'description-writer-1',
      }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.market).toBe(market);
    expect(requests[0]?.tier).toBe('fast');
    expect(requests[0]?.system).toContain('about 50 words, in a warm and inviting tone');
  });

  it('writes for an admin on the Market tier, without a seller switch', async () => {
    marketSwitch = { enabled: true, tier: 'balanced' };
    sellerSwitch.clear();
    const result = await write(adminContext(), BODY, 'admin');
    expect(result.ok).toBe(true);
    expect(requests[0]?.tier).toBe('balanced');
  });

  it('sends only the allow-listed fields and no canary', async () => {
    await write(sellerContext());
    const sent = `${requests[0]?.system ?? ''}\n${requests[0]?.input ?? ''}`;
    for (const canary of [SELLER, SELLER_ACCOUNT, String(CANARY_SESSION), market.marketId, ADMIN]) {
      expect(sent).not.toContain(canary);
    }
    const input = requests[0]?.input ?? '';
    const data = JSON.parse(input.slice(input.indexOf('{'), input.lastIndexOf('}') + 1)) as object;
    expect(Object.keys(data).sort()).toEqual([
      'category',
      'keywords',
      'note',
      'productDetails',
      'title',
    ]);
  });

  it('refuses a body that names a seller, a Market or a price', async () => {
    const result = await write(sellerContext(), {
      ...BODY,
      sellerId: OTHER_SELLER,
      marketId: 'XX',
      price: 450,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('validation.failed');
    expect(requests).toHaveLength(0);
  });

  it('counts per seller and per Market: one seller at the limit leaves the other free', async () => {
    preset.set('ai-suggest.seller.day', 50);
    expect(await write(sellerContext())).toMatchObject({
      ok: false,
      error: { code: 'ai.limit-reached', resetZone: zone },
    });
    const keys = [...counts.keys()];
    expect(keys.every((key) => key.startsWith(`${market.marketId}|`))).toBe(true);
    expect(keys).toContain(`${market.marketId}|ai-suggest.seller.day|${SELLER}|2026-11-13`);
    preset.clear();
    expect((await write(sellerContext(OTHER_SELLER, OTHER_ACCOUNT))).ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('says how long until the Market midnight when the day is used up', async () => {
    preset.set('ai-suggest.seller.day', 50);
    const result = await write(sellerContext());
    expect(!result.ok && result.error).toEqual({
      code: 'ai.limit-reached',
      retryAfterSeconds: 4 * 60 * 60,
      resetZone: zone,
    });
  });

  it('throttles a burst before the day is used up', async () => {
    preset.set('ai-suggest.account.minute', 6);
    const result = await write(sellerContext());
    expect(!result.ok && result.error.code).toBe('request.throttled');
    expect(requests).toHaveLength(0);
  });

  it('uses the admin day counter for an admin', async () => {
    preset.set('ai-suggest.account.day', 50);
    const result = await write(adminContext(), BODY, 'admin');
    expect(!result.ok && result.error.code).toBe('ai.limit-reached');
  });

  describe('the non-AI paths end without a draft', () => {
    it.each([
      ['the Market switch is off', () => (marketSwitch = { enabled: false, tier: 'fast' })],
      ['the settings store fails', () => (marketSwitch = 'throws')],
      ['the seller switch is off', () => sellerSwitch.set(SELLER, false)],
      ['no model or the kill switch', () => (configured = false)],
    ])('%s: ai.writer-off, nothing counted or sent', async (_name, arrange) => {
      arrange();
      const result = await write(sellerContext());
      expect(!result.ok && result.error.code).toBe('ai.writer-off');
      expect(requests).toHaveLength(0);
      expect(counts.size).toBe(0);
      const available = await writerAvailability(deps(), sellerContext(), 'seller');
      expect(available).toEqual(ok({ available: false, resetZone: zone }));
    });

    it.each([
      [{ ok: false, failure: 'timeout' }, 'ai.writer-failed'],
      [{ ok: false, failure: 'unavailable' }, 'ai.writer-failed'],
      [{ ok: false, failure: 'incomplete' }, 'ai.writer-failed'],
      [{ ok: false, failure: 'not-configured' }, 'ai.writer-off'],
    ] as const)('provider answers %j: %s', async (failed, expected) => {
      answer = failed;
      const result = await write(sellerContext());
      expect(!result.ok && result.error.code).toBe(expected);
    });

    it.each(['down', 'throws', 'short'] as const)(
      'the claim matcher is %s: no draft (fail closed)',
      async (state) => {
        matcherState = state;
        const result = await write(sellerContext());
        expect(!result.ok && result.error.code).toBe('ai.writer-failed');
      },
    );

    it('an acting-as session is refused and never offered', async () => {
      const result = await write(actingAs());
      expect(!result.ok && result.error.code).toBe('access.acting-as-refused');
      expect(requests).toHaveLength(0);
      expect(await writerAvailability(deps(), actingAs(), 'seller')).toEqual(
        ok({ available: false, resetZone: zone }),
      );
    });

    it('a caller of the other population is denied', async () => {
      expect(await write(adminContext(), BODY, 'seller')).toEqual(err({ code: 'access.denied' }));
      expect(await write(sellerContext(), BODY, 'admin')).toEqual(err({ code: 'access.denied' }));
    });
  });

  it('is available when both switches and the model are on', async () => {
    expect(await writerAvailability(deps(), sellerContext(), 'seller')).toEqual(
      ok({ available: true, resetZone: zone }),
    );
  });

  it('drops a sentence the Market vocabulary matches and counts it as certification', async () => {
    answer = { ok: true, text: 'The rice is tayyib. Firm grains for biryani.' };
    const result = await write(sellerContext());
    expect(result).toMatchObject(
      ok({ text: 'Firm grains for biryani.', leftOut: { certification: 1, other: 0 } }),
    );
    expect(matched).toEqual([['The rice is tayyib.', 'Firm grains for biryani.']]);
  });

  it('withholds a draft whose every sentence is left out', async () => {
    answer = { ok: true, text: 'Certified halal. Free delivery today.' };
    expect(await write(sellerContext())).toEqual(
      err({ code: 'ai.draft-withheld', leftOut: { certification: 1, other: 1 } }),
    );
  });

  it.each(WRITER_EVALUATION_SET.map((c) => [c.id, c] as const))(
    'evaluation case %s through the whole writer leaks nothing',
    async (_id, evaluationCase) => {
      answer = { ok: true, text: evaluationCase.draft };
      const result = await write(sellerContext(), evaluationCase.input);
      const text = result.ok ? result.value.text.toLowerCase() : '';
      for (const banned of evaluationCase.mustNotShow) {
        expect(text).not.toContain(banned.toLowerCase());
      }
      for (const kept of evaluationCase.mustShow ?? []) {
        expect(text).toContain(kept.toLowerCase());
      }
    },
  );
});
