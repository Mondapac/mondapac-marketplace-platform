import { describe, expect, it } from 'vitest';
import { shortDateInZone } from './format.ts';

describe('shortDateInZone', () => {
  it('reads the day in the zone, not in UTC', () => {
    expect(shortDateInZone('2026-10-26T14:00:00Z', 'en-AU', 'Australia/Brisbane')).toBe('27 Oct');
    expect(shortDateInZone('2026-10-26T14:00:00Z', 'en-AU', 'UTC')).toBe('26 Oct');
  });

  it('reads an unknown zone in UTC, and a bad or missing instant as a dash', () => {
    expect(shortDateInZone('2026-10-26T14:00:00Z', 'en-AU', 'Nowhere/Land')).toBe('26 Oct');
    expect(shortDateInZone('nope', 'en-AU', 'UTC')).toBe('-');
    expect(shortDateInZone(null, 'en-AU', 'UTC')).toBe('-');
  });
});
