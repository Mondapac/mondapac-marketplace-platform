import { describe, expect, it } from 'vitest';
import { waitingAge } from './waiting-age.ts';

const now = new Date('2026-11-25T12:00:00Z');

describe('waitingAge', () => {
  it('counts days and hours, hours and minutes, or minutes', () => {
    expect(waitingAge('2026-11-22T07:30:00Z', now)).toEqual({ key: 'days', days: 3, hours: 4 });
    expect(waitingAge('2026-11-25T06:50:00Z', now)).toEqual({
      key: 'hours',
      hours: 5,
      minutes: 10,
    });
    expect(waitingAge('2026-11-25T11:48:30Z', now)).toEqual({ key: 'minutes', minutes: 11 });
  });
  it('treats a future time as no wait and an unreadable one as unknown', () => {
    expect(waitingAge('2026-11-25T13:00:00Z', now)).toEqual({ key: 'minutes', minutes: 0 });
    expect(waitingAge('not a time', now)).toBeNull();
  });
});
