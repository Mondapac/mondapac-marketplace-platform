import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { OFFER_CHANGE_REASONS, PRODUCT_CHANGE_REASONS } from '../../domain/events';
import type { OfferApprove } from './offer-approve.use-case';
import type { OfferRequestChanges } from './offer-request-changes.use-case';
import type { ProductRevisionApprove } from './product-revision-approve.use-case';
import type { ProductRevisionRequestChanges } from './product-revision-request-changes.use-case';
import { ReviewQueueBulkDecide } from './review-queue-bulk-decide.use-case';

// `review-queue.bulk-decide` in memory on both Market fixtures: the closed request, per-kind items,
// john's decision (a bulk approve never ticks a check: rows needing checks are skipped and
// reported), and that each row runs the single use case as the caller. Singles are fakes here.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-20T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('review queue bulk decide in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const context = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );

  type Answer = Result<unknown, { readonly code: string }>;
  function setup(
    answer: (action: string, input: Record<string, unknown>) => Answer = () => ok({}),
    allow = true,
  ) {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const single = (action: string) => ({
      execute: (_c: CallContext, input: Record<string, unknown>): Promise<Answer> => {
        calls.push({ action, input });
        return Promise.resolve(answer(action, input));
      },
    });
    const check: AuthorisationCheck = {
      check: () =>
        Promise.resolve(
          allow ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
        ),
    };
    const useCase = new ReviewQueueBulkDecide(createUseCaseGate(markets, check), {
      revisionApprove: single('revision-approve') as unknown as ProductRevisionApprove,
      revisionRequestChanges: single(
        'revision-changes',
      ) as unknown as ProductRevisionRequestChanges,
      offerApprove: single('offer-approve') as unknown as OfferApprove,
      offerRequestChanges: single('offer-changes') as unknown as OfferRequestChanges,
    });
    return { useCase, calls };
  }

  const product = () => ids.next<'Product'>() as string;
  const revision = () => ids.next<'ProductRevision'>() as string;
  const offer = () => ids.next<'Offer'>() as string;

  it('declares the approve key and refuses a seller session', async () => {
    expect(ReviewQueueBulkDecide.access).toEqual({
      name: 'catalog.review-queue-bulk-decide',
      rule: { kind: 'permissions', allOf: ['catalog.product.approve'] },
    });
    const { useCase, calls } = setup();
    const result = await useCase.execute(context('seller'), {
      kind: 'offer',
      action: 'approve',
      items: [{ id: offer(), version: 1 }],
    });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(calls).toEqual([]);
  });

  it('approves revisions with no check ticked and skips the rows that need checks', async () => {
    const a = product();
    const b = product();
    const { useCase, calls } = setup((_action, input) =>
      input['productId'] === b ? err({ code: 'review.checks-missing' }) : ok({}),
    );
    const result = await useCase.execute(context('admin'), {
      kind: 'revision',
      action: 'approve',
      items: [
        { id: a, revisionId: revision(), version: 3 },
        { id: b, revisionId: revision(), version: 2 },
      ],
    });
    expect(result.ok && result.value.counts).toEqual({ done: 1, skipped: 1, failed: 0 });
    expect(result.ok && result.value.results).toEqual([
      { id: a, outcome: 'done' },
      { id: b, outcome: 'skipped', reason: 'review.checks-missing' },
    ]);
    expect(calls.every((c) => (c.input['checksConfirmed'] as unknown[]).length === 0)).toBe(true);
  });

  it('skips offers that cannot be decided now and fails an unexpected refusal', async () => {
    const [a, b, c, d] = [offer(), offer(), offer(), offer()];
    const codes: Record<string, string> = {
      [b]: 'offer.not-pending-review',
      [c]: 'seller.not-eligible',
      [d]: 'claim.check-unavailable',
    };
    const { useCase } = setup((_a, input) => {
      const code = codes[input['offerId'] as string];
      return code === undefined ? ok({}) : err({ code });
    });
    const result = await useCase.execute(context('admin'), {
      kind: 'offer',
      action: 'approve',
      items: [a, b, c, d].map((id) => ({ id, version: 1 })),
    });
    expect(result.ok && result.value.counts).toEqual({ done: 1, skipped: 2, failed: 1 });
  });

  it('sends rows back with one reason code per kind', async () => {
    const { useCase, calls } = setup();
    const p = product();
    const rev = revision();
    await useCase.execute(context('admin'), {
      kind: 'revision',
      action: 'request-changes',
      reasonCode: PRODUCT_CHANGE_REASONS[0],
      items: [{ id: p, revisionId: rev, version: 1 }],
    });
    const o = offer();
    await useCase.execute(context('admin'), {
      kind: 'offer',
      action: 'request-changes',
      reasonCode: OFFER_CHANGE_REASONS[0],
      items: [{ id: o, version: 4 }],
    });
    expect(calls).toEqual([
      {
        action: 'revision-changes',
        input: { productId: p, revisionId: rev, version: 1, reasonCode: PRODUCT_CHANGE_REASONS[0] },
      },
      {
        action: 'offer-changes',
        input: { offerId: o, version: 4, reasonCode: OFFER_CHANGE_REASONS[0] },
      },
    ]);
  });

  it('refuses a malformed request before any row runs', async () => {
    const { useCase, calls } = setup();
    const p = product();
    const r = revision();
    const o = offer();
    const bodies: unknown[] = [
      null,
      { action: 'approve', items: [{ id: o, version: 1 }] },
      { kind: 'other', action: 'approve', items: [{ id: o, version: 1 }] },
      { kind: 'offer', action: 'explode', items: [{ id: o, version: 1 }] },
      { kind: 'offer', action: 'approve', reasonCode: 'x', items: [{ id: o, version: 1 }] },
      { kind: 'offer', action: 'request-changes', items: [{ id: o, version: 1 }] },
      {
        kind: 'offer',
        action: 'request-changes',
        reasonCode: 'nope',
        items: [{ id: o, version: 1 }],
      },
      { kind: 'offer', action: 'approve', items: [] },
      {
        kind: 'offer',
        action: 'approve',
        items: [
          { id: o, version: 1 },
          { id: o, version: 1 },
        ],
      },
      { kind: 'revision', action: 'approve', items: [{ id: p, version: 1 }] },
      { kind: 'revision', action: 'approve', items: [{ id: p, revisionId: r, version: 0 }] },
      { kind: 'revision', action: 'approve', items: [{ id: p, revisionId: r, version: 1, x: 1 }] },
      {
        kind: 'revision',
        action: 'approve',
        items: [
          { id: p, revisionId: r, version: 1 },
          { id: p, revisionId: r, version: 1 },
        ],
      },
      { kind: 'offer', action: 'approve', items: [{ id: o, version: 1 }], extra: true },
    ];
    for (const body of bodies) {
      const result = await useCase.execute(context('admin'), body);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('validation.failed');
    }
    expect(calls).toEqual([]);
  });

  it('refuses an admin who lacks the approve key before any row runs', async () => {
    const { useCase, calls } = setup(() => ok({}), false);
    const result = await useCase.execute(context('admin'), {
      kind: 'offer',
      action: 'approve',
      items: [{ id: offer(), version: 1 }],
    });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(calls).toEqual([]);
  });

  it('skips a row whose own key check is denied and goes on with the rest', async () => {
    const [a, b] = [offer(), offer()];
    const { useCase } = setup((_a, input) =>
      input['offerId'] === a ? err({ code: 'access.denied' }) : ok({}),
    );
    const result = await useCase.execute(context('admin'), {
      kind: 'offer',
      action: 'approve',
      items: [a, b].map((id) => ({ id, version: 1 })),
    });
    expect(result.ok && result.value.counts).toEqual({ done: 1, skipped: 1, failed: 0 });
  });

  it('takes exactly 50 rows and refuses a reason code of the other kind', async () => {
    const { useCase, calls } = setup();
    const items = Array.from({ length: 50 }, () => ({ id: offer(), version: 1 }));
    const fifty = await useCase.execute(context('admin'), {
      kind: 'offer',
      action: 'approve',
      items,
    });
    expect(fifty.ok && fifty.value.counts.done).toBe(50);
    const wrong = [...PRODUCT_CHANGE_REASONS].find(
      (r) => !(OFFER_CHANGE_REASONS as readonly string[]).includes(r),
    );
    const before = calls.length;
    if (wrong !== undefined) {
      const result = await useCase.execute(context('admin'), {
        kind: 'offer',
        action: 'request-changes',
        reasonCode: wrong,
        items: [{ id: offer(), version: 1 }],
      });
      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(before);
    }
  });

  it('refuses more than 50 rows', async () => {
    const { useCase } = setup();
    const items = Array.from({ length: 51 }, () => ({ id: offer(), version: 1 }));
    const result = await useCase.execute(context('admin'), {
      kind: 'offer',
      action: 'approve',
      items,
    });
    expect(result).toEqual({ ok: false, error: { code: 'batch.too-large', max: 50 } });
    const revisions = Array.from({ length: 51 }, () => ({
      id: product(),
      revisionId: revision(),
      version: 1,
    }));
    const second = await useCase.execute(context('admin'), {
      kind: 'revision',
      action: 'approve',
      items: revisions,
    });
    expect(second).toEqual({ ok: false, error: { code: 'batch.too-large', max: 50 } });
  });
});
