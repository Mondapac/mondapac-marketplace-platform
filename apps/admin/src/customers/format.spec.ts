import { describe, expect, it } from 'vitest';
import { timeOf } from './format.ts';

// Times are shown in the admin's zone with the zone's name, for any Market (ADR-0005).
describe('timeOf', () => {
  const at = '2026-11-10T23:30:00.000Z';

  it('shows the time in the given zone with its name, for two Markets', () => {
    const brisbane = timeOf(at, 'en-AU', 'Australia/Brisbane');
    expect(brisbane).toMatch(/11 Nov 2026/);
    expect(brisbane).toMatch(/9:30/);
    expect(brisbane).toMatch(/AEST|GMT\+10/);
    const auckland = timeOf(at, 'en-NZ', 'Pacific/Auckland');
    expect(auckland).toMatch(/11 Nov 2026/);
    expect(auckland).toMatch(/12:30/);
    expect(auckland).toMatch(/NZDT|GMT\+13/);
  });

  it('falls back to UTC on a zone it does not know, and says nothing for no time', () => {
    expect(timeOf(at, 'en-AU', 'Not/AZone')).toMatch(/UTC/);
    expect(timeOf(null, 'en-AU', 'Australia/Brisbane')).toBe('-');
    expect(timeOf('not a date', 'en-AU', 'Australia/Brisbane')).toBe('-');
  });
});
