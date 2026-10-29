import { describe, expect, it } from 'vitest';
import { zoneLabel } from '../src/checkout/schedule.ts';

describe('zoneLabel', () => {
  it('names the city of a zone, however many parts it has', () => {
    expect(zoneLabel('Australia/Brisbane', 'en')).toBe('Brisbane');
    expect(zoneLabel('America/Argentina/Buenos_Aires', 'en')).toBe('Buenos Aires');
    expect(zoneLabel('America/Indiana/Indianapolis', 'en')).toBe('Indianapolis');
  });

  it('uses the zone name where there is no city, and the id for an unknown zone', () => {
    expect(zoneLabel('UTC', 'en')).toMatch(/Coordinated|UTC|GMT/);
    expect(zoneLabel('Etc/UTC', 'en')).toMatch(/Coordinated|UTC|GMT/);
    expect(zoneLabel('Not/AZone', 'en')).toBe('AZone');
  });
});
