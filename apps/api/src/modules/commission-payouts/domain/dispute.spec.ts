import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  DISPUTE_STATUSES,
  bucketOf,
  decisionRule,
  decisionsBySellerOrder,
  moneyStateOf,
  needsReview,
  recoverableCap,
  recoveredOf,
  releasable,
  sellerShareOf,
  type DisputeCase,
  type DisputeDecision,
  type SellerOrderDecision,
} from './dispute';
import type { LedgerEntry, LedgerKind } from './ledger';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const SO1 = id<'SellerOrder'>(0x201);
const SO2 = id<'SellerOrder'>(0x202);

type State = Pick<DisputeCase, 'status' | 'closed' | 'outcome' | 'fundsReinstated'>;
const open = (status: State['status']): State => ({
  status,
  closed: false,
  outcome: null,
  fundsReinstated: false,
});
const lost: State = { status: 'lost', closed: true, outcome: 'lost', fundsReinstated: false };
const lostReinstated: State = { ...lost, fundsReinstated: true };
const won: State = { status: 'won', closed: true, outcome: 'won', fundsReinstated: false };

const decision = (
  n: number,
  sellerOrderId: Id<'SellerOrder'>,
  bearer: 'platform' | 'seller',
  supersedes: DisputeDecision['supersedes'] = null,
  currency = 'AUD',
): DisputeDecision => ({
  id: id<'DisputeDecision'>(n),
  disputeId: id<'Dispute'>(0x901),
  sellerOrderId,
  sellerId: id<'Seller'>(0x51),
  bearer,
  amount: bearer === 'seller' ? money(500n, currency) : null,
  reasonCode: 'other',
  decidedBy: id<'Account'>(0xad),
  decidedAt: T0,
  supersedes,
});

const entry = (kind: LedgerKind, amount: bigint, n: number): LedgerEntry => ({
  id: id<'LedgerEntry'>(0x700 + n),
  sellerId: id<'Seller'>(0x51),
  orderId: id<'Order'>(0x101),
  sellerOrderId: SO1,
  orderLineId: null,
  kind,
  amount: money(amount, 'AUD'),
  rateBps: null,
  baseAmount: null,
  sourceId: null,
  occurredAt: T0,
  recordedAt: T0,
});

describe('moneyStateOf', () => {
  it.each([
    [{ fundsWithdrawn: false, fundsReinstated: false, inquiry: true }, 'inquiry'],
    [{ fundsWithdrawn: true, fundsReinstated: false, inquiry: false }, 'withdrawn'],
    [{ fundsWithdrawn: true, fundsReinstated: true, inquiry: false }, 'reinstated'],
    [{ fundsWithdrawn: false, fundsReinstated: false, inquiry: false }, 'none'],
    // An inquiry that became a chargeback: the money is out, the flag may still say inquiry.
    [{ fundsWithdrawn: true, fundsReinstated: false, inquiry: true }, 'withdrawn'],
  ] as const)('%j is %s', (flags, expected) => {
    expect(moneyStateOf(flags)).toBe(expected);
  });
});

describe('bucketOf', () => {
  const none = new Map<Id<'SellerOrder'>, SellerOrderDecision>();
  it('puts an open case by Stripe status: evidence wanted or with the bank', () => {
    expect(bucketOf(open('needs_response'), [SO1], none)).toBe('needs-response');
    expect(bucketOf(open('warning_needs_response'), [SO1], none)).toBe('needs-response');
    expect(bucketOf(open('under_review'), [SO1], none)).toBe('under-review');
    expect(bucketOf(open('warning_under_review'), [SO1], none)).toBe('under-review');
  });

  it('a won chargeback is won, a closed inquiry is closed', () => {
    expect(bucketOf(won, [SO1], none)).toBe('won');
    expect(
      bucketOf(
        { status: 'warning_closed', closed: true, outcome: null, fundsReinstated: false },
        [SO1],
        none,
      ),
    ).toBe('closed');
    expect(
      bucketOf(
        { status: 'prevented', closed: true, outcome: null, fundsReinstated: false },
        [SO1],
        none,
      ),
    ).toBe('closed');
  });

  it('a lost chargeback needs a decision until every seller order has one', () => {
    expect(bucketOf(lost, [SO1, SO2], none)).toBe('decision-needed');
    const one = decisionsBySellerOrder([decision(1, SO1, 'platform')]);
    expect(bucketOf(lost, [SO1, SO2], one)).toBe('decision-needed');
    const both = decisionsBySellerOrder([decision(1, SO1, 'platform'), decision(2, SO2, 'seller')]);
    expect(bucketOf(lost, [SO1, SO2], both)).toBe('closed');
  });

  it('a lost case with no seller order is closed', () => {
    expect(bucketOf(lost, [], none)).toBe('closed');
  });

  it('needs review (lost, then reinstated) stays decision-needed while a seller still repays', () => {
    const repaying = decisionsBySellerOrder([decision(1, SO1, 'seller')]);
    expect(bucketOf(lostReinstated, [SO1], repaying)).toBe('decision-needed');
    const reversed = decisionsBySellerOrder([
      decision(1, SO1, 'seller'),
      decision(2, SO1, 'platform', id<'DisputeDecision'>(1)),
    ]);
    expect(bucketOf(lostReinstated, [SO1], reversed)).toBe('closed');
    const platform = decisionsBySellerOrder([decision(1, SO1, 'platform')]);
    expect(bucketOf(lostReinstated, [SO1], platform)).toBe('closed');
  });

  it('every status has exactly one bucket for every decision state', () => {
    for (const status of DISPUTE_STATUSES) {
      for (const closed of [false, true]) {
        const outcome = status === 'won' ? 'won' : status === 'lost' ? 'lost' : null;
        // Stripe closes won, lost, warning_closed and prevented.
        const isClosed = ['won', 'lost', 'warning_closed', 'prevented'].includes(status);
        if (closed !== isClosed) continue;
        expect(['needs-response', 'under-review', 'decision-needed', 'won', 'closed']).toContain(
          bucketOf({ status, closed, outcome, fundsReinstated: false }, [SO1], none),
        );
      }
    }
  });
});

describe('releasable (never release an open case; release a closed one by outcome)', () => {
  const decided = (ids: Id<'SellerOrder'>[]) =>
    decisionsBySellerOrder(ids.map((s, i) => decision(i + 1, s, 'platform')));

  it('never releases while open, whatever the decisions', () => {
    for (const status of ['needs_response', 'under_review', 'warning_needs_response'] as const) {
      expect(releasable(open(status), [SO1], decided([SO1]))).toBe(false);
    }
  });

  it('releases a won chargeback and a closed inquiry without any decision', () => {
    const none = decided([]);
    expect(releasable(won, [SO1, SO2], none)).toBe(true);
    expect(releasable({ closed: true, outcome: null }, [SO1, SO2], none)).toBe(true);
  });

  it('releases a lost chargeback only when every seller order is decided', () => {
    expect(releasable(lost, [SO1, SO2], decided([]))).toBe(false);
    expect(releasable(lost, [SO1, SO2], decided([SO1]))).toBe(false);
    expect(releasable(lost, [SO1, SO2], decided([SO2]))).toBe(false);
    expect(releasable(lost, [SO1, SO2], decided([SO1, SO2]))).toBe(true);
    expect(releasable(lost, [], decided([]))).toBe(true);
  });

  it('property: over all closed/outcome/decided combinations, release happens exactly by the rule', () => {
    const sellerOrders = [SO1, SO2];
    const subsets: Id<'SellerOrder'>[][] = [[], [SO1], [SO2], [SO1, SO2]];
    for (const closed of [false, true]) {
      for (const outcome of [null, 'won', 'lost'] as const) {
        for (const subset of subsets) {
          const expected =
            closed && (outcome !== 'lost' || (subset.length === 2 && sellerOrders.length === 2));
          expect(releasable({ closed, outcome }, sellerOrders, decided(subset))).toBe(expected);
        }
      }
    }
  });
});

describe('decisionRule', () => {
  const none = undefined;
  const seller = (): SellerOrderDecision => ({ first: decision(1, SO1, 'seller'), reversal: null });
  const platform = (): SellerOrderDecision => ({
    first: decision(1, SO1, 'platform'),
    reversal: null,
  });

  it('refuses a decision on an open case or a won one', () => {
    for (const state of [open('needs_response'), won]) {
      expect(decisionRule(state, none, 'seller')).toEqual({
        ok: false,
        code: 'commission-payouts.dispute.not-decidable',
      });
    }
  });

  it('allows a first decision on a lost chargeback, either bearer', () => {
    expect(decisionRule(lost, none, 'seller')).toEqual({ ok: true, kind: 'new' });
    expect(decisionRule(lost, none, 'platform')).toEqual({ ok: true, kind: 'new' });
  });

  it('refuses a second decision unless needs-review and seller to platform', () => {
    const already = { ok: false, code: 'commission-payouts.dispute.already-decided' };
    expect(decisionRule(lost, seller(), 'platform')).toEqual(already);
    expect(decisionRule(lost, seller(), 'seller')).toEqual(already);
    expect(decisionRule(lostReinstated, seller(), 'seller')).toEqual(already);
    expect(decisionRule(lostReinstated, platform(), 'platform')).toEqual(already);
    expect(decisionRule(lostReinstated, platform(), 'seller')).toEqual(already);
    expect(decisionRule(lostReinstated, seller(), 'platform')).toEqual({
      ok: true,
      kind: 'reverse',
    });
    // Once reversed, never again.
    expect(
      decisionRule(
        lostReinstated,
        { first: decision(1, SO1, 'seller'), reversal: decision(2, SO1, 'platform', id(1)) },
        'platform',
      ),
    ).toEqual(already);
  });

  it('needsReview is closed, lost and reinstated only', () => {
    expect(needsReview(lostReinstated)).toBe(true);
    expect(needsReview(lost)).toBe(false);
    expect(needsReview({ ...won, fundsReinstated: true })).toBe(false);
    expect(needsReview({ ...open('needs_response'), fundsReinstated: true })).toBe(false);
  });
});

describe('the recovery cap (Q-O4)', () => {
  it('is the unreversed share: sale, shipping and returned commission less commission and refunds', () => {
    const rows = [
      entry('sale', 10_000n, 1),
      entry('shipping', 800n, 2),
      entry('commission', 1_500n, 3),
      entry('refund-sale', 2_000n, 4),
      entry('refund-shipping', 300n, 5),
      entry('refund-commission', 300n, 6),
    ];
    // 10000 + 800 - 1500 - 2000 - 300 + 300
    expect(sellerShareOf(rows)).toBe(7_300n);
    expect(recoverableCap(rows)).toBe(7_300n);
  });

  it('commission is not reversed: it stays out of the cap as a debit already taken', () => {
    expect(recoverableCap([entry('sale', 1_000n, 1), entry('commission', 150n, 2)])).toBe(850n);
  });

  it('takes earlier dispute recovery off the cap and gives a reinstatement back', () => {
    const base = [entry('sale', 1_000n, 1), entry('commission', 100n, 2)];
    expect(recoverableCap([...base, entry('dispute-debit', 400n, 3)])).toBe(500n);
    expect(
      recoverableCap([
        ...base,
        entry('dispute-debit', 400n, 3),
        entry('dispute-reinstate', 400n, 4),
      ]),
    ).toBe(900n);
  });

  it('is never below zero (after refunds ate the share)', () => {
    expect(
      recoverableCap([
        entry('sale', 100n, 1),
        entry('refund-sale', 100n, 2),
        entry('commission', 15n, 3),
      ]),
    ).toBe(0n);
    expect(recoverableCap([])).toBe(0n);
  });
});

describe('recoveredOf', () => {
  it('is the seller decision amount, unless reversed or the platform bore it', () => {
    expect(recoveredOf(undefined)).toBeNull();
    expect(recoveredOf({ first: decision(1, SO1, 'platform'), reversal: null })).toBeNull();
    expect(recoveredOf({ first: decision(1, SO1, 'seller'), reversal: null })).toEqual(
      money(500n, 'AUD'),
    );
    expect(
      recoveredOf({
        first: decision(1, SO1, 'seller'),
        reversal: decision(2, SO1, 'platform', id(1)),
      }),
    ).toBeNull();
  });
});
