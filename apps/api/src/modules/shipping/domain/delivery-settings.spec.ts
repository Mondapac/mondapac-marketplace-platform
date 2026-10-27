import { Temporal } from '@mondapac/shared-kernel';
import {
  checkChoice,
  checkScheduledWindow,
  DEFAULT_DELIVERY_SETTINGS,
  evaluateMethods,
  formatCutoff,
  isBeforeSameDayCutoff,
  parseCutoff,
  parseDeliverySettings,
  parseMethodSet,
  type AvailabilityFacts,
  type DeliverySettings,
} from './delivery-settings';
import { DELIVERY_METHODS, type DeliveryMethod } from './delivery-methods';

const at = (iso: string) => Temporal.Instant.from(iso);

// The Market zones of the two fixtures: AU is Brisbane (no daylight saving), ZZ is Tokyo. The
// rest are the zones of sellers that differ from the Market's (ADR-0005).
const ZONES = {
  AU: 'Australia/Brisbane',
  ZZ: 'Asia/Tokyo',
};

describe('the default settings', () => {
  it('has every method on, a 12:00 cut-off, 7 days, 2-hour windows and no margin', () => {
    expect(DEFAULT_DELIVERY_SETTINGS).toMatchObject({
      enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
      sameDayCutoffMinutes: 720,
      scheduledDaysAhead: 7,
      scheduledWindowMinutes: 120,
      margin: { kind: 'none' },
      roundingStepMinor: 1,
      version: 0,
    });
  });
});

describe('cut-off time text', () => {
  it('round-trips HH:MM', () => {
    expect(parseCutoff('12:00')).toBe(720);
    expect(parseCutoff('00:00')).toBe(0);
    expect(parseCutoff('23:59')).toBe(1439);
    expect(formatCutoff(0)).toBe('00:00');
    expect(formatCutoff(1439)).toBe('23:59');
    expect(formatCutoff(725)).toBe('12:05');
  });
  it.each(['24:00', '12:60', '1:00', '12:0', '', 'noon', 1200, null])('refuses %j', (value) => {
    expect(parseCutoff(value)).toBeNull();
  });
});

describe('isBeforeSameDayCutoff across zones and daylight saving', () => {
  const NOON = 720;

  it('reads the cut-off as wall-clock time of the zone, not of UTC', () => {
    // 01:59 UTC is 11:59 in Brisbane (+10) and 10:59 in Perth (+8); 02:00 UTC is 12:00 / 10:00.
    expect(isBeforeSameDayCutoff(at('2026-06-10T01:59:59Z'), 'Australia/Brisbane', NOON)).toBe(
      true,
    );
    expect(isBeforeSameDayCutoff(at('2026-06-10T02:00:00Z'), 'Australia/Brisbane', NOON)).toBe(
      false,
    );
    expect(isBeforeSameDayCutoff(at('2026-06-10T02:00:00Z'), 'Australia/Perth', NOON)).toBe(true);
    expect(isBeforeSameDayCutoff(at('2026-06-10T03:59:59Z'), 'Australia/Perth', NOON)).toBe(true);
    expect(isBeforeSameDayCutoff(at('2026-06-10T04:00:00Z'), 'Australia/Perth', NOON)).toBe(false);
  });

  it('follows daylight saving: Sydney is +11 in January and +10 in June', () => {
    // 12:00 in Sydney is 01:00Z in January and 02:00Z in June.
    expect(isBeforeSameDayCutoff(at('2026-01-15T00:59:59Z'), 'Australia/Sydney', NOON)).toBe(true);
    expect(isBeforeSameDayCutoff(at('2026-01-15T01:00:00Z'), 'Australia/Sydney', NOON)).toBe(false);
    expect(isBeforeSameDayCutoff(at('2026-06-15T01:59:59Z'), 'Australia/Sydney', NOON)).toBe(true);
    expect(isBeforeSameDayCutoff(at('2026-06-15T02:00:00Z'), 'Australia/Sydney', NOON)).toBe(false);
  });

  it('handles the half-hour zone of Adelaide (+10:30 in January, +9:30 in June)', () => {
    expect(isBeforeSameDayCutoff(at('2026-01-15T01:29:59Z'), 'Australia/Adelaide', NOON)).toBe(
      true,
    );
    expect(isBeforeSameDayCutoff(at('2026-01-15T01:30:00Z'), 'Australia/Adelaide', NOON)).toBe(
      false,
    );
    expect(isBeforeSameDayCutoff(at('2026-06-15T02:29:59Z'), 'Australia/Adelaide', NOON)).toBe(
      true,
    );
    expect(isBeforeSameDayCutoff(at('2026-06-15T02:30:00Z'), 'Australia/Adelaide', NOON)).toBe(
      false,
    );
  });

  it('keeps the local cut-off on the days daylight saving starts and ends', () => {
    // Sydney, 2026-10-04: clocks go from 02:00 to 03:00 (+10 -> +11). 12:00 local is 01:00Z.
    expect(isBeforeSameDayCutoff(at('2026-10-04T00:59:59Z'), 'Australia/Sydney', NOON)).toBe(true);
    expect(isBeforeSameDayCutoff(at('2026-10-04T01:00:00Z'), 'Australia/Sydney', NOON)).toBe(false);
    // 2026-04-05: clocks go from 03:00 to 02:00 (+11 -> +10). 12:00 local is 02:00Z.
    expect(isBeforeSameDayCutoff(at('2026-04-05T01:59:59Z'), 'Australia/Sydney', NOON)).toBe(true);
    expect(isBeforeSameDayCutoff(at('2026-04-05T02:00:00Z'), 'Australia/Sydney', NOON)).toBe(false);
    // A cut-off inside the skipped hour (02:30) still reads as local wall-clock time.
    // 15:45Z is 01:45 before the change; 16:15Z is 03:15 after it (02:30 never happens).
    expect(isBeforeSameDayCutoff(at('2026-10-03T15:45:00Z'), 'Australia/Sydney', 150)).toBe(true);
    expect(isBeforeSameDayCutoff(at('2026-10-03T16:15:00Z'), 'Australia/Sydney', 150)).toBe(false);
  });

  it('opens a new day after local midnight, whatever UTC says', () => {
    // 13:59Z on 9 June is 23:59 in Brisbane; 14:00Z is 00:00 of the 10th: before noon again.
    expect(isBeforeSameDayCutoff(at('2026-06-09T13:59:59Z'), 'Australia/Brisbane', NOON)).toBe(
      false,
    );
    expect(isBeforeSameDayCutoff(at('2026-06-09T14:00:00Z'), 'Australia/Brisbane', NOON)).toBe(
      true,
    );
  });

  it('accepts a midnight cut-off (never before) and a 23:59 one', () => {
    expect(isBeforeSameDayCutoff(at('2026-06-10T00:00:00Z'), 'UTC', 0)).toBe(false);
    expect(isBeforeSameDayCutoff(at('2026-06-10T23:58:59Z'), 'UTC', 1439)).toBe(true);
  });
});

describe.each(Object.entries(ZONES))(
  'evaluateMethods, Market %s (zone fallback %s)',
  (_code, marketZone) => {
    const noonLocal = Temporal.PlainDateTime.from('2026-06-10T12:00:00')
      .toZonedDateTime(marketZone)
      .toInstant();
    const before = noonLocal.subtract({ minutes: 1 });
    const facts = (over: Partial<AvailabilityFacts> = {}): AvailabilityFacts => ({
      settings: DEFAULT_DELIVERY_SETTINGS,
      sellerUnsupported: new Set<DeliveryMethod>(),
      hasPickupAddress: true,
      now: before,
      zone: marketZone,
      ...over,
    });
    const verdicts = (f: AvailabilityFacts) =>
      Object.fromEntries(evaluateMethods(f).map((v) => [v.method, v.reason ?? 'ok']));

    it('offers every method by default, in the fixed order', () => {
      expect(evaluateMethods(facts()).map((v) => v.method)).toEqual([...DELIVERY_METHODS]);
      expect(verdicts(facts())).toEqual({
        pickup: 'ok',
        instant: 'ok',
        same_day: 'ok',
        scheduled: 'ok',
      });
    });

    it('refuses a method the Market switched off, for every seller', () => {
      const settings: DeliverySettings = {
        ...DEFAULT_DELIVERY_SETTINGS,
        enabled: { pickup: true, instant: false, same_day: true, scheduled: false },
      };
      expect(verdicts(facts({ settings }))).toMatchObject({
        instant: 'platform-off',
        scheduled: 'platform-off',
        pickup: 'ok',
      });
    });

    it('refuses a method an admin took away from the seller', () => {
      expect(
        verdicts(facts({ sellerUnsupported: new Set<DeliveryMethod>(['instant']) })),
      ).toMatchObject({
        instant: 'seller-unsupported',
        same_day: 'ok',
      });
    });

    it('names the Market switch before the seller one', () => {
      const settings: DeliverySettings = {
        ...DEFAULT_DELIVERY_SETTINGS,
        enabled: { ...DEFAULT_DELIVERY_SETTINGS.enabled, instant: false },
      };
      expect(
        verdicts(facts({ settings, sellerUnsupported: new Set<DeliveryMethod>(['instant']) }))
          .instant,
      ).toBe('platform-off');
    });

    it('refuses pickup without an approved pickup address', () => {
      expect(verdicts(facts({ hasPickupAddress: false })).pickup).toBe('no-pickup-address');
    });

    it('refuses same day from the cut-off on, in the zone', () => {
      expect(verdicts(facts()).same_day).toBe('ok');
      expect(verdicts(facts({ now: noonLocal })).same_day).toBe('past-cut-off');
      // The same instant is still before noon in Perth, which is behind both Market zones.
      expect(verdicts(facts({ now: noonLocal, zone: 'Australia/Perth' })).same_day).toBe('ok');
    });

    it('uses the configured cut-off', () => {
      const settings = { ...DEFAULT_DELIVERY_SETTINGS, sameDayCutoffMinutes: 15 * 60 + 30 };
      expect(verdicts(facts({ settings, now: noonLocal })).same_day).toBe('ok');
      expect(
        verdicts(facts({ settings, now: noonLocal.add({ hours: 3, minutes: 30 }) })).same_day,
      ).toBe('past-cut-off');
    });

    it('keeps pickup, instant and scheduled open past the cut-off', () => {
      expect(verdicts(facts({ now: noonLocal.add({ hours: 6 }) }))).toMatchObject({
        pickup: 'ok',
        instant: 'ok',
        scheduled: 'ok',
        same_day: 'past-cut-off',
      });
    });
  },
);

describe.each(Object.entries(ZONES))('checkScheduledWindow, Market %s', (_code, zone) => {
  const settings = { scheduledDaysAhead: 7, scheduledWindowMinutes: 120 };
  const now = Temporal.PlainDateTime.from('2026-06-10T09:00:00').toZonedDateTime(zone).toInstant();
  const local = (iso: string) => Temporal.PlainDateTime.from(iso).toZonedDateTime(zone).toInstant();
  const window = (start: string, minutes = 120) => {
    const s = local(start);
    return { start: s, end: s.add({ minutes }) };
  };

  it('accepts a window of the right length within the days ahead', () => {
    expect(checkScheduledWindow(window('2026-06-10T14:00:00'), settings, now, zone)).toBeNull();
    expect(checkScheduledWindow(window('2026-06-17T23:00:00'), settings, now, zone)).toBeNull();
  });

  it('refuses a window that starts now or earlier', () => {
    expect(
      checkScheduledWindow({ start: now, end: now.add({ hours: 2 }) }, settings, now, zone),
    ).toBe('window-in-past');
    expect(checkScheduledWindow(window('2026-06-09T09:00:00'), settings, now, zone)).toBe(
      'window-in-past',
    );
  });

  it('refuses a window beyond the last local day', () => {
    expect(checkScheduledWindow(window('2026-06-18T00:00:00'), settings, now, zone)).toBe(
      'window-too-far',
    );
    expect(checkScheduledWindow(window('2026-07-10T10:00:00'), settings, now, zone)).toBe(
      'window-too-far',
    );
  });

  it('refuses a window of another length', () => {
    expect(checkScheduledWindow(window('2026-06-11T10:00:00', 60), settings, now, zone)).toBe(
      'window-length',
    );
    expect(checkScheduledWindow(window('2026-06-11T10:00:00', 180), settings, now, zone)).toBe(
      'window-length',
    );
  });

  it('follows the configured days and length', () => {
    const tight = { scheduledDaysAhead: 1, scheduledWindowMinutes: 60 };
    expect(checkScheduledWindow(window('2026-06-11T10:00:00', 60), tight, now, zone)).toBeNull();
    expect(checkScheduledWindow(window('2026-06-12T10:00:00', 60), tight, now, zone)).toBe(
      'window-too-far',
    );
    expect(checkScheduledWindow(window('2026-06-11T10:00:00', 120), tight, now, zone)).toBe(
      'window-length',
    );
  });
});

describe('checkScheduledWindow across a daylight-saving change', () => {
  const zone = 'Australia/Sydney';
  const settings = { scheduledDaysAhead: 7, scheduledWindowMinutes: 120 };

  it('counts days on the local calendar, not 24-hour blocks', () => {
    // Saturday 3 Oct 2026 22:00 local; the clocks move forward at 02:00 on Sunday the 4th.
    const now = Temporal.PlainDateTime.from('2026-10-03T22:00:00')
      .toZonedDateTime(zone)
      .toInstant();
    const start = Temporal.PlainDateTime.from('2026-10-10T23:30:00')
      .toZonedDateTime(zone)
      .toInstant();
    // The 10th is 7 local days after the 3rd: on offer, though 7 x 24 h later is already the 11th.
    expect(
      checkScheduledWindow({ start, end: start.add({ hours: 2 }) }, settings, now, zone),
    ).toBeNull();
    const next = Temporal.PlainDateTime.from('2026-10-11T00:30:00')
      .toZonedDateTime(zone)
      .toInstant();
    expect(
      checkScheduledWindow({ start: next, end: next.add({ hours: 2 }) }, settings, now, zone),
    ).toBe('window-too-far');
  });
});

describe('checkChoice', () => {
  const zone = 'Australia/Brisbane';
  const now = at('2026-06-10T00:00:00Z'); // 10:00 in Brisbane
  const facts: AvailabilityFacts = {
    settings: DEFAULT_DELIVERY_SETTINGS,
    sellerUnsupported: new Set(),
    hasPickupAddress: true,
    now,
    zone,
  };
  const window = { start: at('2026-06-10T08:00:00Z'), end: at('2026-06-10T10:00:00Z') };

  it('allows an available method', () => {
    expect(checkChoice(facts, { method: 'instant', window: null })).toBeNull();
    expect(checkChoice(facts, { method: 'scheduled', window })).toBeNull();
  });

  it('gives the reason of an unavailable method', () => {
    expect(
      checkChoice({ ...facts, hasPickupAddress: false }, { method: 'pickup', window: null }),
    ).toBe('no-pickup-address');
    expect(
      checkChoice(
        { ...facts, now: at('2026-06-10T03:00:00Z') },
        { method: 'same_day', window: null },
      ),
    ).toBe('past-cut-off');
  });

  it('needs a window for scheduled and checks it', () => {
    expect(checkChoice(facts, { method: 'scheduled', window: null })).toBe('window-missing');
    expect(
      checkChoice(facts, {
        method: 'scheduled',
        window: { start: window.start, end: window.start.add({ hours: 1 }) },
      }),
    ).toBe('window-length');
  });
});

describe('parseDeliverySettings', () => {
  const good = {
    enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
    sameDayCutoff: '11:30',
    scheduledDaysAhead: 5,
    scheduledWindowMinutes: 90,
    margin: { kind: 'fixed', amountMinor: 150 },
    roundingStepMinor: 10,
  };

  it('accepts a full set', () => {
    expect(parseDeliverySettings(good)).toEqual({
      ok: true,
      value: {
        enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
        sameDayCutoffMinutes: 690,
        scheduledDaysAhead: 5,
        scheduledWindowMinutes: 90,
        margin: { kind: 'fixed', amountMinor: 150 },
        roundingStepMinor: 10,
      },
    });
  });

  it.each([
    [{ ...good, enabled: { pickup: true } }, 'enabled.instant'],
    [{ ...good, enabled: { ...good.enabled, other: true } }, 'enabled.field'],
    [{ ...good, enabled: { ...good.enabled, pickup: 'yes' } }, 'enabled.pickup'],
    [{ ...good, enabled: [] }, 'enabled'],
    [{ ...good, sameDayCutoff: '12:60' }, 'sameDayCutoff'],
    [{ ...good, scheduledDaysAhead: 0 }, 'scheduledDaysAhead'],
    [{ ...good, scheduledDaysAhead: 31 }, 'scheduledDaysAhead'],
    [{ ...good, scheduledDaysAhead: 2.5 }, 'scheduledDaysAhead'],
    [{ ...good, scheduledWindowMinutes: 20 }, 'scheduledWindowMinutes'],
    [{ ...good, scheduledWindowMinutes: 100 }, 'scheduledWindowMinutes'],
    [{ ...good, scheduledWindowMinutes: 495 }, 'scheduledWindowMinutes'],
    [{ ...good, margin: { kind: 'percent', basisPoints: 20000 } }, 'margin.basisPoints'],
    [{ ...good, roundingStepMinor: 25 }, 'roundingStepMinor'],
    [{ ...good, nope: 1 }, 'field'],
    [null, ''],
  ])('refuses %j at %s', (input, path) => {
    const parsed = parseDeliverySettings(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.fields.map((field) => field.path)).toContain(path);
  });

  it('allows every method off', () => {
    const parsed = parseDeliverySettings({
      ...good,
      enabled: { pickup: false, instant: false, same_day: false, scheduled: false },
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('parseMethodSet', () => {
  it('returns the methods once each, in the fixed order', () => {
    expect(parseMethodSet(['scheduled', 'pickup', 'pickup'])).toEqual(['pickup', 'scheduled']);
    expect(parseMethodSet([])).toEqual([]);
  });
  it.each([
    ['instant'],
    [['bogus']],
    [[1]],
    [null],
    [['pickup', 'instant', 'same_day', 'scheduled', 'pickup']],
  ])('refuses %j', (value) => {
    expect(parseMethodSet(value)).toBeNull();
  });
});
