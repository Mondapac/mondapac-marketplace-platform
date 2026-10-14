import { Temporal } from '@mondapac/shared-kernel';
import {
  clampCoolingOffHours,
  coolingOffAfter,
  desiredSchedule,
  isCoolingOff,
  kindOf,
  scheduleKey,
} from './payout-change';

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const at = (hours: number) => T0.add({ hours });

describe('clampCoolingOffHours', () => {
  it('keeps 24 h to 14 d, rounds a fraction up, and takes 14 d for anything else', () => {
    expect(clampCoolingOffHours(24)).toBe(24);
    expect(clampCoolingOffHours(72)).toBe(72);
    expect(clampCoolingOffHours(336)).toBe(336);
    expect(clampCoolingOffHours(1)).toBe(24);
    expect(clampCoolingOffHours(0)).toBe(24);
    expect(clampCoolingOffHours(-5)).toBe(24);
    expect(clampCoolingOffHours(24.2)).toBe(25);
    expect(clampCoolingOffHours(100_000)).toBe(336);
    for (const invalid of [undefined, null, '24', Number.NaN, Infinity, {}, true]) {
      expect(clampCoolingOffHours(invalid)).toBe(336);
    }
  });
});

describe('kindOf', () => {
  it('is initial only for the first destination added, and a change otherwise', () => {
    expect(kindOf('account.external_account.created', false)).toBe('initial');
    expect(kindOf('account.external_account.created', true)).toBe('added');
    expect(kindOf('account.external_account.updated', false)).toBe('updated');
    expect(kindOf('account.external_account.updated', true)).toBe('updated');
    expect(kindOf('account.external_account.deleted', false)).toBe('removed');
    expect(kindOf('account.external_account.deleted', true)).toBe('removed');
  });
});

describe('coolingOffAfter', () => {
  it('has no waiting period for the initial destination and leaves an existing one alone', () => {
    expect(coolingOffAfter('initial', T0, 24, null)).toBeNull();
  });

  it('is detection plus the hours, and never earlier than a stored value', () => {
    expect(coolingOffAfter('updated', T0, 24, null)?.toString()).toBe(at(24).toString());
    expect(coolingOffAfter('added', at(1), 24, at(48))?.toString()).toBe(at(48).toString());
    expect(coolingOffAfter('removed', at(30), 24, at(48))?.toString()).toBe(at(54).toString());
  });
});

describe('isCoolingOff and desiredSchedule', () => {
  it('is cooling off strictly before the end instant', () => {
    expect(isCoolingOff(null, T0)).toBe(false);
    expect(isCoolingOff(at(1), T0)).toBe(true);
    expect(isCoolingOff(T0, T0)).toBe(false);
    expect(desiredSchedule(at(1), T0)).toBe('manual');
    expect(desiredSchedule(T0, T0)).toBe('normal');
    expect(desiredSchedule(null, T0)).toBe('normal');
  });
});

describe('scheduleKey', () => {
  it('names the change, and a re-pause gets its own key', () => {
    expect(scheduleKey('pause', 'c1', 0)).toBe('payout-pause:c1');
    expect(scheduleKey('resume', 'c1', 0)).toBe('payout-resume:c1');
    expect(scheduleKey('pause', 'c1', 2)).toBe('payout-pause:c1:r2');
  });
});
