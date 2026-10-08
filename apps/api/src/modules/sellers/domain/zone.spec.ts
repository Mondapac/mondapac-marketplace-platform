import { zoneAfterAddressSave, type RegionZones, type ZoneState } from './zone';

// Zones of the fixtures' regions: AU QLD and NSW, and ZZ's two-zone region ZB.
const QLD: RegionZones = {
  default: 'Australia/Brisbane',
  selectable: ['Australia/Brisbane', 'Australia/Lindeman'],
};
const NSW: RegionZones = {
  default: 'Australia/Sydney',
  selectable: ['Australia/Sydney', 'Australia/Broken_Hill', 'Australia/Lord_Howe'],
};
const ZB: RegionZones = {
  default: 'Pacific/Auckland',
  selectable: ['Pacific/Auckland', 'Pacific/Chatham'],
};

const none = { chosen: undefined, hint: undefined };
const zone = (
  operatingTimezone: string,
  timezoneSource: ZoneState['timezoneSource'],
  addressTimezone: string,
): ZoneState => ({
  operatingTimezone,
  timezoneSource,
  addressTimezone,
});

describe('zoneAfterAddressSave', () => {
  it.each([
    ['QLD', QLD],
    ['NSW', NSW],
    ['ZB', ZB],
  ])('starts a first address of %s at the region default', (_region, zones) => {
    expect(zoneAfterAddressSave(null, zones, none)).toEqual({
      ok: true,
      value: zone(zones.default, 'default', zones.default),
    });
  });

  it('takes a chosen zone on the list, exactly as written, with source seller', () => {
    expect(zoneAfterAddressSave(null, ZB, { chosen: 'Pacific/Chatham', hint: undefined })).toEqual({
      ok: true,
      value: zone('Pacific/Chatham', 'seller', 'Pacific/Auckland'),
    });
  });

  it.each([
    'Australia/Perth',
    'australia/broken_hill',
    'Australia/NSW',
    'Etc/GMT-10',
    '+10:00',
    'UTC',
    '',
    42,
    null,
  ])('refuses a chosen zone %j that is not on the region list', (chosen) => {
    expect(zoneAfterAddressSave(null, NSW, { chosen, hint: undefined })).toEqual({
      ok: false,
      error: { code: 'timezone.not-selectable' },
    });
  });

  it('refuses any chosen zone when the Market has no zones for the address', () => {
    expect(
      zoneAfterAddressSave(null, null, { chosen: 'Pacific/Chatham', hint: undefined }),
    ).toEqual({
      ok: false,
      error: { code: 'timezone.not-selectable' },
    });
    expect(zoneAfterAddressSave(null, null, none)).toEqual({ ok: true, value: null });
  });

  it('keeps a zone a person chose while it stays on the list, and moves the address zone', () => {
    const chosen = zone('Australia/Broken_Hill', 'seller', 'Australia/Sydney');
    expect(zoneAfterAddressSave(chosen, NSW, none)).toEqual({ ok: true, value: chosen });
    const admin = zone('Pacific/Chatham', 'admin', 'Pacific/Auckland');
    expect(zoneAfterAddressSave(admin, ZB, none)).toEqual({ ok: true, value: admin });
  });

  it('resets a chosen zone that is not on the new region list to the new default', () => {
    const chosen = zone('Australia/Broken_Hill', 'seller', 'Australia/Sydney');
    expect(zoneAfterAddressSave(chosen, QLD, none)).toEqual({
      ok: true,
      value: zone('Australia/Brisbane', 'default', 'Australia/Brisbane'),
    });
  });

  it('moves a default zone with the region', () => {
    const before = zone('Australia/Sydney', 'default', 'Australia/Sydney');
    expect(zoneAfterAddressSave(before, QLD, none)).toEqual({
      ok: true,
      value: zone('Australia/Brisbane', 'default', 'Australia/Brisbane'),
    });
  });

  describe('the browser hint', () => {
    it('applies to a draft whose zone nobody set, when it is on the list', () => {
      expect(
        zoneAfterAddressSave(null, ZB, { chosen: undefined, hint: 'Pacific/Chatham' }),
      ).toEqual({
        ok: true,
        value: zone('Pacific/Chatham', 'browser', 'Pacific/Auckland'),
      });
      const byDefault = zone('Australia/Sydney', 'default', 'Australia/Sydney');
      expect(
        zoneAfterAddressSave(byDefault, NSW, { chosen: undefined, hint: 'Australia/Lord_Howe' }),
      ).toEqual({ ok: true, value: zone('Australia/Lord_Howe', 'browser', 'Australia/Sydney') });
    });

    it.each(['Australia/Perth', 'Etc/UTC', '+10:00', 'x'.repeat(65), 7, {}])(
      'is dropped silently when it is %j (the address wins)',
      (hint) => {
        expect(zoneAfterAddressSave(null, NSW, { chosen: undefined, hint })).toEqual({
          ok: true,
          value: zone('Australia/Sydney', 'default', 'Australia/Sydney'),
        });
      },
    );

    it('never overrides a zone a seller or an admin set', () => {
      for (const source of ['seller', 'admin'] as const) {
        const set = zone('Australia/Broken_Hill', source, 'Australia/Sydney');
        expect(
          zoneAfterAddressSave(set, NSW, { chosen: undefined, hint: 'Australia/Lord_Howe' }),
        ).toEqual({ ok: true, value: set });
      }
    });

    it('loses to a chosen zone in the same save', () => {
      expect(
        zoneAfterAddressSave(null, NSW, {
          chosen: 'Australia/Sydney',
          hint: 'Australia/Lord_Howe',
        }),
      ).toEqual({ ok: true, value: zone('Australia/Sydney', 'seller', 'Australia/Sydney') });
    });
  });
});
