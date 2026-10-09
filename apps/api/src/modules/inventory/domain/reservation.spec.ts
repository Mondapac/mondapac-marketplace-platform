import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Reservation, type PlaceReservation } from './reservation';

const T0 = Temporal.Instant.from('2026-10-09T01:00:00Z');
const id = <K extends string>(n: number) =>
  `0199c1a0-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<K>;

// The Market's reservation duration differs per fixture (AU 15 minutes, ZZ 10).
describe.each([
  ['AU', 15],
  ['ZZ', 10],
] as const)('Reservation in market %s (duration %i minutes)', (_code, minutes) => {
  const input = (): PlaceReservation => ({
    id: id(1),
    holderAccountId: id(2),
    checkoutRef: id(3),
    lines: [{ id: id(10), offerId: id(11), variantId: id(12), stockItemId: id(13), quantity: 2 }],
    now: T0,
    duration: Temporal.Duration.from({ minutes }),
  });

  it('is placed active with expiry = created + duration and a mirrored active line', () => {
    const reservation = Reservation.place(input());

    expect(reservation.state.status).toBe('active');
    expect(reservation.state.expiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      minutes * 60_000,
    );
    expect(reservation.state.lines.map((line) => line.status)).toEqual(['active']);
    expect(reservation.state.version).toBe(1);
  });

  it('is live before expiry and expired from the expiry instant on, with no job (AC 4)', () => {
    const reservation = Reservation.place(input());
    const before = T0.add({ minutes }).subtract({ milliseconds: 1 });
    const at = T0.add({ minutes });

    expect(reservation.isLiveAt(before)).toBe(true);
    expect(reservation.isLiveAt(at)).toBe(false);
    expect(reservation.isExpiredAt(at)).toBe(true);
  });

  it('matches a replay with the same checkout and lines, in any order, and nothing else', () => {
    const reservation = Reservation.place(input());
    const line = { offerId: id(11), variantId: id(12), quantity: 2 };

    expect(reservation.matches(id(3), [line])).toBe(true);
    expect(reservation.matches(id(4), [line])).toBe(false);
    expect(reservation.matches(id(3), [{ ...line, quantity: 3 }])).toBe(false);
    expect(reservation.matches(id(3), [line, { ...line, offerId: id(99) }])).toBe(false);
  });

  it('releases with a cause, mirrors the lines, and raises the version', () => {
    const released = Reservation.place(input()).release('superseded', T0.add({ minutes: 1 }));

    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.outcome).toBe('released');
    expect(released.value.next.state).toMatchObject({
      status: 'released',
      releaseCause: 'superseded',
      version: 2,
    });
    expect(released.value.next.state.lines.map((line) => line.status)).toEqual(['released']);
  });

  it('releases an expired-but-still-active reservation (a newer reserve supersedes it)', () => {
    const late = T0.add({ minutes: minutes + 5 });
    const released = Reservation.place(input()).release('superseded', late);

    expect(released.ok && released.value.outcome).toBe('released');
  });

  it('keeps the first cause when released twice, and does nothing to an expired one', () => {
    const first = Reservation.place(input()).release('customer', T0);
    if (!first.ok) throw new Error('release failed');
    const second = first.value.next.release('cancelled', T0.add({ minutes: 1 }));

    expect(second.ok && second.value.outcome).toBe('unchanged');
    expect(second.ok && second.value.next.state.releaseCause).toBe('customer');

    const expired = Reservation.place(input()).expire(T0.add({ minutes }));
    const again = expired?.release('customer', T0.add({ minutes: minutes + 1 }));
    expect(again?.ok && again.value.outcome).toBe('unchanged');
  });

  it('refuses to release a committed reservation', () => {
    const committed = Reservation.fromStored({
      ...Reservation.place(input()).state,
      status: 'committed',
    });

    expect(committed.release('customer', T0).ok).toBe(false);
  });

  it('expires only once due, and mirrors the lines', () => {
    const reservation = Reservation.place(input());

    expect(reservation.expire(T0.add({ minutes }).subtract({ seconds: 1 }))).toBeNull();
    const expired = reservation.expire(T0.add({ minutes }));
    expect(expired?.state.status).toBe('expired');
    expect(expired?.state.lines.map((line) => line.status)).toEqual(['expired']);
    expect(expired?.expire(T0.add({ minutes: minutes + 1 }))).toBeNull();
  });
});
