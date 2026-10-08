import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeNotifier,
  InMemoryCounters,
  InMemoryRevisions,
  TransactionalUnitOfWork,
} from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { newPendingRevision, type BusinessFileRevision } from '../../domain/business-file-revision';
import { identifierIndexKeyOf } from '../../domain/business-identifier';
import type { RevisionKind } from '../../domain/revision-kinds';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { AfterSubmission } from './after-submission.use-case';

// The reviewer notice after a submission (sellers design 7.5; data design 3.11; Ali R-3), on both
// Market fixtures: two coalescing windows reserved in units of one counter each, kept only when
// identity says `sent`, released on every other outcome, and a delivery that is retried when
// identity could not be reached.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const market = (code: string): MarketContext => testMarketContext(code, 'default');

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const revisions = new InMemoryRevisions();
  const counters = new InMemoryCounters();
  const notifier = new FakeNotifier();
  const unitOfWork = new TransactionalUnitOfWork([revisions, counters]);
  const useCase = new AfterSubmission(gate, {
    unitOfWork,
    revisions,
    counters,
    counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
    notifier,
    clock,
  });
  let delivered = 0;
  return {
    clock,
    ids,
    revisions,
    counters,
    notifier,
    useCase,
    delivery: (): EventDelivery => ({
      eventId: ids.next<'event'>(),
      subscriber: 'sellers.after-submission',
      attempt: (delivered += 1),
    }),
  };
}

type Setup = ReturnType<typeof setUp>;

function submitted(
  t: Setup,
  code: string,
  status: BusinessFileRevision['status'] = 'pending',
  kind: RevisionKind = 'onboarding',
) {
  const sellerId = t.ids.next<'Seller'>();
  const base = newPendingRevision({
    id: t.ids.next<'BusinessFileRevision'>(),
    sellerId,
    kind,
    revisionNo: 1,
    authorKind: 'seller',
    authorAccountId: t.ids.next<'Account'>(),
    snapshot: {
      operatingTimezone: 'Pacific/Auckland',
      serviceAreaCode: 'area-1',
      addressTimezone: 'Pacific/Auckland',
      identifierIndex: identifierIndexKeyOf(new Uint8Array(32).fill(1)),
    },
    contentHash: `hmac-sha256:${'a'.repeat(64)}` as never,
    register: { outcome: 'not-performed', mismatches: [], checkedAt: null },
    now: START,
  });
  const revision = {
    ...base,
    status,
    withdrawal:
      status === 'withdrawn'
        ? { cause: 'edited' as const, byKind: 'seller' as const, at: START }
        : null,
  };
  void t.revisions.add(market(code), revision, {
    ciphertext: 'sealed.x' as never,
    contentHash: revision.contentHash,
  });
  return { sellerId, revisionId: revision.id };
}

const systemContext = (code: string): CallContext => testCallContext(market(code), 'system');

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(['AU', 'ZZ'])('sellers.after-submission in %s', (code) => {
  const run = (
    t: Setup,
    s: { sellerId: Id<'Seller'>; revisionId: Id },
    kind: RevisionKind = 'onboarding',
  ) =>
    t.useCase.execute(systemContext(code), {
      delivery: t.delivery(),
      sellerId: s.sellerId,
      revisionId: s.revisionId,
      kind,
    });

  it('tells the reviewers once and keeps both reservations when identity says sent', async () => {
    const t = setUp();
    const s = submitted(t, code);

    const result = await run(t, s);

    expect(result).toEqual({ ok: true, value: { code: 'after-submission.notified' } });
    expect(t.notifier.calls).toEqual([s.sellerId]);
    expect(t.counters.countOf('reviewer-notice.seller')).toBe(1);
    expect(t.counters.countOf('reviewer-notice.market')).toBe(1);
  });

  it('coalesces a second seller into the Market window: both counters are kept and nothing is sent', async () => {
    const t = setUp();
    const first = submitted(t, code);
    const second = submitted(t, code);
    await run(t, first);

    const result = await run(t, second);

    expect(result).toEqual({ ok: true, value: { code: 'after-submission.coalesced' } });
    expect(t.notifier.calls).toEqual([first.sellerId]);
    expect(t.counters.countOf('reviewer-notice.seller')).toBe(2);
    expect(t.counters.countOf('reviewer-notice.market')).toBe(2);
  });

  it('coalesces the same seller within six hours without touching the Market window', async () => {
    const t = setUp();
    const s = submitted(t, code);
    await run(t, s);
    t.clock.advance(Temporal.Duration.from({ minutes: 20 }));

    const again = await run(t, { sellerId: s.sellerId, revisionId: s.revisionId });

    expect(again).toEqual({ ok: true, value: { code: 'after-submission.coalesced' } });
    expect(t.notifier.calls).toHaveLength(1);
    // The seller window refused first: the Market window was not reserved a second time.
    expect(t.counters.countOf('reviewer-notice.market')).toBe(1);
    expect(t.counters.countOf('reviewer-notice.seller')).toBe(2);
  });

  it('sends again in a later Market window', async () => {
    const t = setUp();
    const first = submitted(t, code);
    const second = submitted(t, code);
    await run(t, first);
    t.clock.advance(Temporal.Duration.from({ minutes: 16 }));

    const result = await run(t, second);

    expect(result).toEqual({ ok: true, value: { code: 'after-submission.notified' } });
    expect(t.notifier.calls).toEqual([first.sellerId, second.sellerId]);
  });

  it('releases both reservations when identity skips the notice, and marks the delivery handled', async () => {
    const t = setUp();
    const s = submitted(t, code);
    t.notifier.answers = ['skipped'];

    const result = await run(t, s);

    expect(result).toEqual({ ok: true, value: { code: 'after-submission.skipped' } });
    expect(t.counters.countOf('reviewer-notice.seller')).toBe(0);
    expect(t.counters.countOf('reviewer-notice.market')).toBe(0);
  });

  it.each(['unavailable', 'throw'] as const)(
    'releases both reservations and fails the delivery when identity answers %s, so a retry can send',
    async (answer) => {
      const t = setUp();
      const s = submitted(t, code);
      t.notifier.answers = [answer, 'sent'];
      const delivery = t.delivery();
      const input = {
        delivery,
        sellerId: s.sellerId,
        revisionId: s.revisionId,
        kind: 'onboarding' as const,
      };

      await expect(t.useCase.execute(systemContext(code), input)).rejects.toThrow();
      expect(t.counters.countOf('reviewer-notice.seller')).toBe(0);
      expect(t.counters.countOf('reviewer-notice.market')).toBe(0);

      const retried = await t.useCase.execute(systemContext(code), { ...input, delivery });
      expect(retried).toEqual({ ok: true, value: { code: 'after-submission.notified' } });
      expect(t.notifier.calls).toHaveLength(2);
      expect(t.counters.countOf('reviewer-notice.seller')).toBe(1);
    },
  );

  it('does not release a window that restarted in between', async () => {
    const t = setUp();
    const s = submitted(t, code);
    t.notifier.answers = ['skipped'];
    // The Market window restarts while identity is being asked: a later reservation owns it.
    const original = t.notifier.notify.bind(t.notifier);
    t.notifier.notify = async (context, sellerId) => {
      t.clock.advance(Temporal.Duration.from({ minutes: 16 }));
      await t.counters.reserve(
        market(code),
        [
          {
            limit: { kind: 'reviewer-notice.market', limit: 1, windowMinutes: 15 },
            keyHash: new HmacRateCounterKeys(new Uint8Array(32).fill(7)).keyOf(
              market(code),
              'reviewer-notice.market',
              market(code).marketId,
            ),
          },
        ],
        t.clock.now(),
      );
      return original(context, sellerId);
    };

    await run(t, s);

    // The seller window was released; the Market row now belongs to the other reservation.
    expect(t.counters.countOf('reviewer-notice.seller')).toBe(0);
    expect(t.counters.countOf('reviewer-notice.market')).toBe(1);
  });

  it('releases the seller window when the Market window cannot be reserved, and retries', async () => {
    const t = setUp();
    const s = submitted(t, code);
    t.counters.failingKind = 'reviewer-notice.market';

    await expect(run(t, s)).rejects.toThrow();

    expect(t.counters.countOf('reviewer-notice.seller')).toBe(0);
    expect(t.notifier.calls).toEqual([]);
  });

  it('does nothing for a revision that is no longer pending, or not an onboarding one', async () => {
    const t = setUp();
    const withdrawn = submitted(t, code, 'withdrawn');
    const change = submitted(t, code, 'pending', 'identity-change');

    expect(await run(t, withdrawn)).toEqual({
      ok: true,
      value: { code: 'after-submission.skipped' },
    });
    expect(await run(t, change, 'identity-change')).toEqual({
      ok: true,
      value: { code: 'after-submission.skipped' },
    });
    expect(t.notifier.calls).toEqual([]);
    expect(t.counters.countOf('reviewer-notice.seller')).toBe(0);
  });

  it('handles a redelivery of the same event once', async () => {
    const t = setUp();
    const s = submitted(t, code);
    const delivery = t.delivery();
    const input = {
      delivery,
      sellerId: s.sellerId,
      revisionId: s.revisionId,
      kind: 'onboarding' as const,
    };
    await t.useCase.execute(systemContext(code), input);

    const again = await t.useCase.execute(systemContext(code), input);

    // The second run found the revision pending and reserved again; it is coalesced, and the
    // inbox reports the event as already handled.
    expect(again).toEqual({ ok: true, value: { code: 'after-submission.already-handled' } });
    expect(t.notifier.calls).toHaveLength(1);
  });

  it('is for the system actor only', async () => {
    const t = setUp();
    const s = submitted(t, code);

    const result = await t.useCase.execute(testCallContext(market(code), 'anonymous'), {
      delivery: t.delivery(),
      sellerId: s.sellerId,
      revisionId: s.revisionId,
      kind: 'onboarding',
    });

    expect(result.ok).toBe(false);
    expect(t.notifier.calls).toEqual([]);
  });
});
