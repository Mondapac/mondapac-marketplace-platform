import { Temporal } from '@mondapac/shared-kernel';
import { parseSchedule } from './schedule';

const now = Temporal.Instant.from('2026-10-28T00:00:00Z');
const run = (value: unknown) => {
  const problems: { path: string; code: string }[] = [];
  return { at: parseSchedule(problems, 'scheduledAt', value, now), problems };
};

describe('schedule', () => {
  it('accepts an instant with an offset between now and a year ahead', () => {
    expect(run('2026-10-29T09:00:00+10:00').at?.toString()).toBe('2026-10-28T23:00:00Z');
  });

  it.each([
    ['2026-10-27T00:00:00Z', 'past'],
    ['2026-10-28T00:00:00Z', 'past'],
    ['2028-01-01T00:00:00Z', 'too-far'],
    ['tomorrow', 'format'],
    ['2026-10-29T09:00', 'format'],
  ])('refuses %s', (value, code) => {
    expect(run(value).problems).toEqual([{ path: 'scheduledAt', code }]);
  });

  it('needs a value', () => {
    expect(run(undefined).problems).toEqual([{ path: 'scheduledAt', code: 'required' }]);
    expect(run(5).problems).toEqual([{ path: 'scheduledAt', code: 'type' }]);
  });
});
