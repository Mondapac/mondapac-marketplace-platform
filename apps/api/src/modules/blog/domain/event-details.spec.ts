import { Temporal } from '@mondapac/shared-kernel';
import { parseEventDetails, parseEventStatusChange, parseHttpsUrl } from './event-details';
import type { Problems } from './fields';

const base = {
  startsAt: '2026-12-01T10:00',
  endsAt: '2026-12-01T12:00',
  attendance: 'offline',
  venueName: 'Town hall',
};

describe('event details', () => {
  it('reads local times in the Market zone, or the zone given', () => {
    const brisbane = parseEventDetails([], 'event', base, 'Australia/Brisbane');
    expect(brisbane?.startsAt.toString()).toBe('2026-12-01T00:00:00Z');
    const tokyo = parseEventDetails(
      [],
      'event',
      { ...base, timeZone: 'Asia/Tokyo' },
      'Australia/Brisbane',
    );
    expect(tokyo?.startsAt.toString()).toBe('2026-12-01T01:00:00Z');
    expect(tokyo?.eventStatus).toBe('scheduled');
  });

  it('reads an instant with an offset as it is', () => {
    const event = parseEventDetails(
      [],
      'event',
      { ...base, startsAt: '2026-12-01T10:00:00+10:00', endsAt: '2026-12-01T12:00:00+10:00' },
      'Asia/Tokyo',
    );
    expect(event?.startsAt).toEqual(Temporal.Instant.from('2026-12-01T00:00:00Z'));
  });

  it.each([
    ['an end before the start', { endsAt: '2026-12-01T09:00' }, 'event.endsAt', 'before-start'],
    ['a window over 744 hours', { endsAt: '2027-02-01T10:00' }, 'event.endsAt', 'too-long'],
    ['a bad time', { startsAt: 'tomorrow' }, 'event.startsAt', 'format'],
    ['a zone that does not exist', { timeZone: 'Mars/Base' }, 'event.timeZone', 'value'],
    ['an offline event with no venue', { venueName: undefined }, 'event.venueName', 'required'],
    ['an unknown attendance', { attendance: 'telepathy' }, 'event.attendance', 'value'],
    [
      'a registration URL over http',
      { registrationUrl: 'http://x.test/a' },
      'event.registrationUrl',
      'scheme',
    ],
    ['markup in the venue', { venueName: '<b>x</b>' }, 'event.venueName', 'markup'],
    ['an unknown field', { price: 5 }, 'event.price', 'unknown-field'],
  ])('refuses %s', (_name, change, path, code) => {
    const problems: Problems = [];
    const event = parseEventDetails(
      problems,
      'event',
      { ...base, ...change },
      'Australia/Brisbane',
    );
    expect(event).toBeNull();
    expect(problems).toContainEqual({ path, code });
  });

  it('lets an online event have no venue', () => {
    const event = parseEventDetails(
      [],
      'event',
      {
        ...base,
        attendance: 'online',
        venueName: undefined,
        registrationUrl: 'https://tickets.test/e',
      },
      'Australia/Brisbane',
    );
    expect(event).toMatchObject({ venueName: null, registrationUrl: 'https://tickets.test/e' });
  });

  it('accepts only https URLs without credentials or spaces', () => {
    const run = (value: unknown): string | null => parseHttpsUrl([], 'u', value);
    expect(run('https://a.test/x?y=1')).toBe('https://a.test/x?y=1');
    expect(run('')).toBeNull();
    for (const bad of [
      'javascript:alert(1)',
      'https://u:p@a.test',
      'https://a.test/a b',
      'ftp://a.test',
    ]) {
      const problems: Problems = [];
      expect(parseHttpsUrl(problems, 'u', bad)).toBeNull();
      expect(problems).toHaveLength(1);
    }
  });

  it('parses a status change', () => {
    expect(parseEventStatusChange({ status: 'cancelled', message: 'Venue closed' }).change).toEqual(
      {
        status: 'cancelled',
        message: 'Venue closed',
      },
    );
    expect(parseEventStatusChange({ status: 'cancelled' }).change).toEqual({
      status: 'cancelled',
      message: null,
    });
    expect(parseEventStatusChange({ status: 'gone' }).problems).toEqual([
      { path: 'status', code: 'value' },
    ]);
    expect(parseEventStatusChange({ status: 'postponed', message: '<b>' }).problems).toEqual([
      { path: 'message', code: 'markup' },
    ]);
  });
});
