import { describe, expect, it } from 'vitest';
import { localZone, shortInstantInZone } from './format.ts';

describe('localZone (ADR-0005)', () => {
  it("takes the holder's own zone first, then the Market's", () => {
    expect(localZone('Asia/Tokyo', 'Australia/Brisbane')).toBe('Asia/Tokyo');
    expect(localZone(null, 'Australia/Brisbane')).toBe('Australia/Brisbane');
    expect(localZone('', 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('skips a zone this runtime does not know, and falls back to UTC, never the browser zone', () => {
    expect(localZone('Mars/Olympus', 'Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(localZone(null, undefined)).toBe('UTC');
    expect(localZone(undefined, 'Mars/Olympus')).toBe('UTC');
  });
});

describe('shortInstantInZone with past years', () => {
  it('adds the year only when it is not this year on the zone clock', () => {
    const lastYear = `${new Date().getUTCFullYear() - 1}-06-15T02:00:00.000Z`;
    expect(shortInstantInZone(lastYear, 'en-AU', 'Australia/Brisbane', true)).toContain(
      String(new Date().getUTCFullYear() - 1),
    );
    expect(shortInstantInZone(lastYear, 'en-AU', 'Australia/Brisbane')).not.toContain(
      String(new Date().getUTCFullYear() - 1),
    );
    const now = new Date().toISOString();
    expect(shortInstantInZone(now, 'en-AU', 'UTC', true)).not.toContain(
      String(new Date().getUTCFullYear()),
    );
  });
});
