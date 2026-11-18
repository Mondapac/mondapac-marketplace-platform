import { Temporal } from '@mondapac/shared-kernel';
import { isLocalDay, localDayEnd, localDayStart, plainDayOf } from './local-day';

// A filter day read in a zone (ADR-0005), pure: the first instant of the day and of the next one,
// including days whose midnight a daylight-saving change skips or repeats, and days that do not
// exist.

const at = (iso: string) => Temporal.Instant.from(iso);

describe('a local filter day', () => {
  it('starts and ends at local midnight on an ordinary day, in different zones', () => {
    expect(localDayStart('2026-11-16', 'Australia/Brisbane')).toEqual(at('2026-11-15T14:00:00Z'));
    expect(localDayEnd('2026-11-16', 'Australia/Brisbane')).toEqual(at('2026-11-16T14:00:00Z'));
    expect(localDayStart('2026-11-16', 'Asia/Tokyo')).toEqual(at('2026-11-15T15:00:00Z'));
    expect(localDayStart('2026-11-16', 'UTC')).toEqual(at('2026-11-16T00:00:00Z'));
  });

  it('starts at the first instant that exists when DST skips midnight (America/Santiago)', () => {
    // Chile moves 00:00 -> 01:00 on Sunday 6 September 2026: the day starts at 01:00 -03:00.
    expect(localDayStart('2026-09-06', 'America/Santiago')).toEqual(at('2026-09-06T04:00:00Z'));
    // The day before ends where the skipped day starts: no instant falls between them.
    expect(localDayEnd('2026-09-05', 'America/Santiago')).toEqual(
      localDayStart('2026-09-06', 'America/Santiago'),
    );
    // A 23-hour day.
    const start = localDayStart('2026-09-06', 'America/Santiago')!;
    const end = localDayEnd('2026-09-06', 'America/Santiago')!;
    expect(start.until(end).total('hours')).toBe(23);
  });

  it('keeps a repeated hour inside its day and starts the next once (America/Santiago, April)', () => {
    // Chile moves 00:00 -> 23:00 the evening before on Sunday 5 April 2026 (24:00 -03:00 becomes
    // 23:00 -04:00), so 23:00-24:00 on 4 April happens twice and 5 April starts once, at -04:00.
    expect(localDayStart('2026-04-05', 'America/Santiago')).toEqual(at('2026-04-05T04:00:00Z'));
    const start = localDayStart('2026-04-04', 'America/Santiago')!;
    const end = localDayEnd('2026-04-04', 'America/Santiago')!;
    expect(start.until(end).total('hours')).toBe(25);
  });

  it('counts a repeated half hour in the day’s length (Australia/Lord_Howe)', () => {
    // Lord Howe goes back 30 minutes at 02:00 on 5 April 2026; midnight itself is not repeated, so
    // the day is 24.5 hours long and starts at +11:00.
    const start = localDayStart('2026-04-05', 'Australia/Lord_Howe')!;
    expect(start).toEqual(at('2026-04-04T13:00:00Z'));
    expect(start.until(localDayEnd('2026-04-05', 'Australia/Lord_Howe')!).total('hours')).toBe(
      24.5,
    );
  });

  it('refuses days that do not exist', () => {
    for (const day of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31']) {
      expect([day, isLocalDay(day)]).toEqual([day, false]);
      expect(localDayStart(day, 'Australia/Brisbane')).toBeNull();
      expect(localDayEnd(day, 'Australia/Brisbane')).toBeNull();
    }
  });

  it('takes 29 February in a leap year and ends it on 1 March', () => {
    expect(plainDayOf('2028-02-29')?.toString()).toBe('2028-02-29');
    expect(localDayEnd('2028-02-29', 'UTC')).toEqual(at('2028-03-01T00:00:00Z'));
  });

  it('ends 31 December on 1 January of the next year', () => {
    expect(localDayEnd('2026-12-31', 'Pacific/Auckland')).toEqual(at('2026-12-31T11:00:00Z'));
  });

  it('refuses anything that is not a YYYY-MM-DD string', () => {
    for (const day of [
      null,
      20261116,
      '2026-1-16',
      '16/11/2026',
      '2026-11-16T00:00',
      ' 2026-11-16',
    ]) {
      expect(isLocalDay(day)).toBe(false);
    }
  });
});
