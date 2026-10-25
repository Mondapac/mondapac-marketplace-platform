import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { promoExpiry } from './expiry';
import { allocate, isExpired, spendOrder, spendable, type Lot } from './lots';
import { needsReason, refusalFor, WALLET_STATUSES, type WalletStatus } from './wallet-status';

const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const lotId = (n: number): Id<'WalletLot'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'WalletLot'>;
};
const lot = (
  n: number,
  source: Lot['source'],
  remaining: bigint,
  expiresInDays: number | null,
  createdAtDays = 0,
): Lot => ({
  id: lotId(n),
  source,
  remaining,
  expiresAt: expiresInDays === null ? null : T0.add({ hours: expiresInDays * 24 }),
  createdAt: T0.add({ hours: createdAtDays * 24 }),
});

describe('spend order (lots)', () => {
  it('spends the soonest-expiring lot first and refund credit (never expires) last', () => {
    const lots = [
      lot(1, 'refund', 500n, null),
      lot(2, 'promo', 500n, 30),
      lot(3, 'promo', 500n, 10),
    ];
    expect([...lots].sort(spendOrder).map((l) => l.id)).toEqual([lotId(3), lotId(2), lotId(1)]);
  });

  it('puts promo before refund at an equal expiry', () => {
    const expiry = T0.add({ hours: 240 });
    const refund: Lot = { ...lot(1, 'refund', 100n, null), expiresAt: expiry };
    const promo: Lot = { ...lot(2, 'promo', 100n, null), expiresAt: expiry };
    expect([refund, promo].sort(spendOrder).map((l) => l.source)).toEqual(['promo', 'refund']);
  });

  it('breaks a full tie by creation time then id, so the order is stable', () => {
    const older = lot(5, 'promo', 1n, 10, 0);
    const newer = lot(4, 'promo', 1n, 10, 1);
    expect([newer, older].sort(spendOrder).map((l) => l.id)).toEqual([older.id, newer.id]);
  });

  it('never spends an expired lot or an empty one', () => {
    const lots = [lot(1, 'promo', 300n, -1), lot(2, 'promo', 0n, 5), lot(3, 'refund', 200n, null)];
    expect(isExpired(lots[0]!, T0)).toBe(true);
    expect(spendable(lots, T0).map((l) => l.id)).toEqual([lotId(3)]);
    expect(allocate(lots, 201n, T0)).toBeNull();
    expect(allocate(lots, 200n, T0)).toEqual([{ lotId: lotId(3), amount: 200n }]);
  });

  it('splits an amount over lots in spend order, in integers', () => {
    const lots = [
      lot(1, 'refund', 400n, null),
      lot(2, 'promo', 150n, 10),
      lot(3, 'promo', 100n, 5),
    ];
    expect(allocate(lots, 300n, T0)).toEqual([
      { lotId: lotId(3), amount: 100n },
      { lotId: lotId(2), amount: 150n },
      { lotId: lotId(1), amount: 50n },
    ]);
  });

  it('refuses a zero or negative amount', () => {
    expect(allocate([lot(1, 'refund', 5n, null)], 0n, T0)).toBeNull();
    expect(allocate([lot(1, 'refund', 5n, null)], -1n, T0)).toBeNull();
  });
});

describe('promo expiry', () => {
  it('is the Market months later in the Market zone, whatever the zone or month length', () => {
    const grant = Temporal.Instant.from('2026-01-31T00:00:00Z');
    expect(promoExpiry(grant, 12, 'Australia/Brisbane').toString()).toBe('2027-01-31T00:00:00Z');
    // Across a daylight-saving change the wall-clock time is kept (11:00 AEDT becomes 11:00 AEST).
    expect(promoExpiry(grant, 6, 'Australia/Sydney').toString()).toBe('2026-07-31T01:00:00Z');
    // Month ends clamp: 31 January + 1 month is the last day of February.
    expect(promoExpiry(grant, 1, 'UTC').toString()).toBe('2026-02-28T00:00:00Z');
  });
});

describe('wallet state matrix', () => {
  const allowed = (status: WalletStatus) =>
    (['grant', 'hold', 'capture', 'release', 'expire', 'read'] as const).filter(
      (operation) => refusalFor(status, operation) === null,
    );

  it('off refuses everything with wallet.disabled', () => {
    expect(allowed('off')).toEqual([]);
    expect(refusalFor('off', 'release')).toBe('wallet.disabled');
  });

  it('active allows everything', () => {
    expect(allowed('active')).toEqual(['grant', 'hold', 'capture', 'release', 'expire', 'read']);
  });

  it('paused: no new grants or holds; capture, release, expiry and reads continue', () => {
    expect(allowed('paused')).toEqual(['capture', 'release', 'expire', 'read']);
    expect(refusalFor('paused', 'grant')).toBe('wallet.paused');
  });

  it('frozen: only release, expiry and reads; capture is refused', () => {
    expect(allowed('frozen')).toEqual(['release', 'expire', 'read']);
    expect(refusalFor('frozen', 'capture')).toBe('wallet.frozen');
  });

  it('hard rules: a hold is always settled (release and expiry in every state but off)', () => {
    for (const status of WALLET_STATUSES.filter((s) => s !== 'off')) {
      expect(refusalFor(status, 'release')).toBeNull();
      expect(refusalFor(status, 'expire')).toBeNull();
    }
  });

  it('only paused and frozen need a reason', () => {
    expect(WALLET_STATUSES.filter(needsReason)).toEqual(['paused', 'frozen']);
  });
});
