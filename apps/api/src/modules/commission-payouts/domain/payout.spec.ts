import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  approve,
  blockReasonOfRefusal,
  BLOCK_REASONS,
  canTransition,
  COUNTED_STATES,
  FREEING_STATES,
  isFinal,
  isLive,
  LIVE_STATES,
  moveTo,
  openPayout,
  PAYOUT_STATES,
  type NewPayout,
  type PayoutState,
} from './payout';

const NOW = Temporal.Instant.from('2026-10-27T00:00:00Z');
const PAYOUT = '01990000-0000-7000-8000-000000000001' as Id<'Payout'>;
const SELLER = '01990000-0000-7000-8000-0000000000a1' as Id<'Seller'>;
const ADMIN = '01990000-0000-7000-8000-0000000000b1' as Id<'Account'>;
const order = (n: number) => `01990000-0000-7000-8000-00000000010${n}` as Id<'SellerOrder'>;

const base: NewPayout = {
  id: PAYOUT,
  sellerId: SELLER,
  currency: 'AUD',
  items: [
    { sellerOrderId: order(1), amount: 4000n },
    { sellerOrderId: order(2), amount: 3000n },
  ],
  netted: 0n,
  approvalMode: 'AUTO',
  firstPayout: false,
  minimum: 5000n,
  slotAt: NOW,
  now: NOW,
};

describe('openPayout', () => {
  it('instructs an AUTO payout of a seller who has been paid before, in the same unit', () => {
    const payout = openPayout(base);
    expect(payout).toMatchObject({
      state: 'instructing',
      gross: 7000n,
      netted: 0n,
      transfer: 7000n,
      approvalMode: 'AUTO',
      approvalReason: null,
      instructingAt: NOW,
      version: 1,
    });
  });

  it("makes a seller's first payout wait for an admin, whatever the terms", () => {
    const payout = openPayout({ ...base, firstPayout: true });
    expect(payout).toMatchObject({
      state: 'awaiting-approval',
      approvalMode: 'MANUAL',
      approvalReason: 'first-payout',
      instructingAt: null,
    });
  });

  it('makes a MANUAL seller wait, with the terms as the reason', () => {
    expect(openPayout({ ...base, approvalMode: 'MANUAL' })).toMatchObject({
      state: 'awaiting-approval',
      approvalReason: 'terms',
    });
  });

  it('settles by netting when the receivable takes everything, with no approval at all', () => {
    const payout = openPayout({
      ...base,
      netted: 7000n,
      firstPayout: true,
      approvalMode: 'MANUAL',
    });
    expect(payout).toMatchObject({
      state: 'settled-by-netting',
      transfer: 0n,
      netted: 7000n,
      approvalMode: 'AUTO',
      approvalReason: null,
    });
  });

  it('takes the netted part off the transfer', () => {
    expect(openPayout({ ...base, netted: 2500n })).toMatchObject({
      gross: 7000n,
      netted: 2500n,
      transfer: 4500n,
    });
  });

  it('refuses amounts that do not add up', () => {
    expect(() => openPayout({ ...base, netted: 7001n })).toThrow(RangeError);
    expect(() => openPayout({ ...base, netted: -1n })).toThrow(RangeError);
    expect(() => openPayout({ ...base, items: [] })).toThrow(RangeError);
    expect(() => openPayout({ ...base, items: [{ sellerOrderId: order(1), amount: 0n }] })).toThrow(
      RangeError,
    );
  });
});

describe('approve', () => {
  const waiting = openPayout({ ...base, firstPayout: true });

  it('binds the amount the admin saw', () => {
    const approved = approve(waiting, 7000n, ADMIN, NOW.add({ hours: 1 }));
    expect(approved.ok && approved.value).toMatchObject({
      state: 'approved',
      approval: { approvedBy: ADMIN, approvedTransfer: 7000n },
      version: 2,
    });
  });

  it('refuses another amount: 5,999 for 6,000 and any change since the admin looked', () => {
    const six = openPayout({
      ...base,
      items: [{ sellerOrderId: order(1), amount: 6000n }],
      firstPayout: true,
    });
    const refused = approve(six, 5999n, ADMIN, NOW);
    expect(!refused.ok && refused.error.code).toBe('commission-payouts.payout.amount-changed');
    expect(approve(waiting, 7001n, ADMIN, NOW).ok).toBe(false);
  });

  it('only approves a payout that waits', () => {
    const approved = approve(waiting, 7000n, ADMIN, NOW);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const again = approve(approved.value, 7000n, ADMIN, NOW);
    expect(!again.ok && again.error.code).toBe('commission-payouts.payout.not-awaiting-approval');
    expect(approve(openPayout(base), 7000n, ADMIN, NOW).ok).toBe(false);
  });
});

describe('the state machine (design 3.6)', () => {
  const ALLOWED: readonly [PayoutState, PayoutState][] = [
    ['pending', 'instructing'],
    ['pending', 'voided'],
    ['awaiting-approval', 'approved'],
    ['awaiting-approval', 'voided'],
    ['approved', 'instructing'],
    ['approved', 'voided'],
    ['instructing', 'instructed'],
    ['instructing', 'not-sent'],
    ['instructed', 'paid'],
    ['instructed', 'failed'],
  ];

  it('allows exactly the transitions of the design and no other', () => {
    for (const from of PAYOUT_STATES) {
      for (const to of PAYOUT_STATES) {
        const expected = ALLOWED.some(([a, b]) => a === from && b === to);
        expect([from, to, canTransition(from, to)]).toEqual([from, to, expected]);
      }
    }
  });

  it('has five final states, and four live ones that match the unique index', () => {
    expect(PAYOUT_STATES.filter(isFinal).sort()).toEqual(
      ['failed', 'not-sent', 'paid', 'settled-by-netting', 'voided'].sort(),
    );
    expect(LIVE_STATES).toEqual(['pending', 'awaiting-approval', 'approved', 'instructing']);
    expect(PAYOUT_STATES.filter(isLive)).toEqual([...LIVE_STATES]);
  });

  it('frees the seller orders of a payout that did not pay, and only of those', () => {
    expect([...FREEING_STATES].sort()).toEqual(['failed', 'not-sent', 'voided']);
    expect(COUNTED_STATES.filter((state) => FREEING_STATES.includes(state))).toEqual([]);
  });

  it('moves with the version and refuses a move the machine does not have', () => {
    const instructing = openPayout(base);
    const instructed = moveTo(instructing, 'instructed', NOW.add({ minutes: 1 }), {
      transferExecutionId: '01990000-0000-7000-8000-0000000000c1',
    });
    expect(instructed).toMatchObject({ state: 'instructed', version: 2 });
    expect(() => moveTo(instructed, 'instructing', NOW)).toThrow(RangeError);
    expect(() => moveTo(openPayout(base), 'paid', NOW)).toThrow(RangeError);
  });
});

describe('what a seller is told', () => {
  it('keeps the closed list of reasons', () => {
    expect([...BLOCK_REASONS]).toEqual([
      'below-minimum',
      'awaiting-approval',
      'account-not-ready',
      'cooling-off',
      'payouts-paused',
      'zone-missing',
      'second-factor-required',
    ]);
  });

  it('shows the two refusals a seller can act on, and a pause for the rest', () => {
    expect(blockReasonOfRefusal('payments.transfer.account-not-ready')).toBe('account-not-ready');
    expect(blockReasonOfRefusal('payments.transfer.cooling-off')).toBe('cooling-off');
    for (const code of [
      'payments.transfer.insufficient-platform-balance',
      'payments.transfer.provider-refused',
      'payments.transfer.account-under-review',
      'payments.transfer.amount-out-of-range',
    ]) {
      expect(blockReasonOfRefusal(code)).toBe('payouts-paused');
    }
  });
});
