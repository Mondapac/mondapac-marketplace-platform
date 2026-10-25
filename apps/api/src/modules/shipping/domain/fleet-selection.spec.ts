import {
  DEFAULT_RULE,
  needsQuotes,
  parseModelName,
  parseReliability,
  parseSelectionRule,
  rankFleets,
  type Candidate,
  type SelectionRule,
} from './fleet-selection';
import type { FleetCode } from './fleet';

// Ranking by each model kind, ties to Mondapac Drive, and the checks on what an admin submits.
// Pure and deterministic; run on both Market currencies.

describe.each([['AUD'], ['JPY']] as const)('rankFleets in currency %s', (currency) => {
  const quote = (price: number, etaMinutes: number | null) => ({
    price: { amount: BigInt(price), currency },
    etaMinutes,
  });
  const candidate = (
    fleet: FleetCode,
    price: number | null,
    etaMinutes: number | null,
    reliability = 50,
  ): Candidate => ({
    fleet,
    quote: price === null ? null : quote(price, etaMinutes),
    reliability,
  });

  describe('cheapest', () => {
    const rule: SelectionRule = { kind: 'cheapest' };
    it('puts the lowest quote first', () => {
      expect(
        rankFleets(rule, [
          candidate('uber_direct', 1500, 30),
          candidate('zoom2u', 900, 90),
          candidate('mondapac_drive', 1200, 40),
        ]),
      ).toEqual(['zoom2u', 'mondapac_drive', 'uber_direct']);
    });

    it('gives a tie to Mondapac Drive, then to the default order', () => {
      expect(
        rankFleets(rule, [
          candidate('zoom2u', 1000, 30),
          candidate('uber_direct', 1000, 30),
          candidate('mondapac_drive', 1000, 30),
        ]),
      ).toEqual(['mondapac_drive', 'uber_direct', 'zoom2u']);
      expect(
        rankFleets(rule, [candidate('auspost', 1000, null), candidate('zoom2u', 1000, null)]),
      ).toEqual(['zoom2u', 'auspost']);
    });

    it('puts a fleet without a quote after every quoted one, in tie order', () => {
      expect(
        rankFleets(rule, [
          candidate('mondapac_drive', null, null),
          candidate('zoom2u', 5000, 30),
          candidate('auspost', null, null),
          candidate('uber_direct', 4000, 30),
        ]),
      ).toEqual(['uber_direct', 'zoom2u', 'mondapac_drive', 'auspost']);
    });

    it('ignores a quote in another currency than the first fleet in tie order', () => {
      const foreign: Candidate = {
        fleet: 'uber_direct',
        quote: { price: { amount: 1n, currency: 'USD' }, etaMinutes: 1 },
        reliability: 50,
      };
      expect(rankFleets(rule, [foreign, candidate('mondapac_drive', 1200, 40)])).toEqual([
        'mondapac_drive',
        'uber_direct',
      ]);
    });

    it('ranks nobody to nothing', () => {
      expect(rankFleets(rule, [])).toEqual([]);
    });
  });

  describe('weighted', () => {
    const rule = (price: number, eta: number, reliability: number): SelectionRule => ({
      kind: 'weighted',
      weights: { price, eta, reliability },
    });
    const fleets = [
      candidate('mondapac_drive', 1400, 60, 70),
      candidate('uber_direct', 1000, 90, 60),
      candidate('zoom2u', 1200, 20, 95),
    ];

    it('follows price when only price is weighted', () => {
      expect(rankFleets(rule(1, 0, 0), fleets)).toEqual([
        'uber_direct',
        'zoom2u',
        'mondapac_drive',
      ]);
    });

    it('follows the ETA when only the ETA is weighted', () => {
      expect(rankFleets(rule(0, 1, 0), fleets)).toEqual([
        'zoom2u',
        'mondapac_drive',
        'uber_direct',
      ]);
    });

    it('follows reliability when only reliability is weighted', () => {
      expect(rankFleets(rule(0, 0, 1), fleets)).toEqual([
        'zoom2u',
        'mondapac_drive',
        'uber_direct',
      ]);
    });

    it('mixes the three by their weights', () => {
      // Price 1000 scores 1000, 1200 scores 833, 1400 scores 714 (the cheapest over each price);
      // ETA 20 scores 1000, 60 scores 333, 90 scores 222; reliability is x10.
      // 50/30/20: uber 50000+6660+12000=68660, zoom2u 41650+30000+19000=90650, drive 35700+9990+14000=59690.
      expect(rankFleets(rule(50, 30, 20), fleets)).toEqual([
        'zoom2u',
        'uber_direct',
        'mondapac_drive',
      ]);
    });

    it('gives an equal score to Mondapac Drive, whatever the order given', () => {
      const same = [
        candidate('zoom2u', 1000, 30, 50),
        candidate('uber_direct', 1000, 30, 50),
        candidate('mondapac_drive', 1000, 30, 50),
      ];
      expect(rankFleets(rule(1, 1, 1), same)).toEqual(['mondapac_drive', 'uber_direct', 'zoom2u']);
      expect(rankFleets(rule(1, 1, 1), [...same].reverse())).toEqual([
        'mondapac_drive',
        'uber_direct',
        'zoom2u',
      ]);
    });

    it('scores a missing ETA worst, and no ETA at all as no difference', () => {
      const partial = [candidate('uber_direct', 1000, null), candidate('zoom2u', 1000, 60)];
      expect(rankFleets(rule(0, 1, 0), partial)).toEqual(['zoom2u', 'uber_direct']);
      const none = [candidate('zoom2u', 1000, null), candidate('uber_direct', 1000, null)];
      expect(rankFleets(rule(0, 1, 0), none)).toEqual(['uber_direct', 'zoom2u']);
    });

    it('scores a free quote best and survives a zero price', () => {
      expect(
        rankFleets(rule(1, 0, 0), [candidate('uber_direct', 800, 30), candidate('zoom2u', 0, 30)]),
      ).toEqual(['zoom2u', 'uber_direct']);
      expect(
        rankFleets(rule(1, 0, 0), [candidate('uber_direct', 0, 30), candidate('zoom2u', 0, 30)]),
      ).toEqual(['uber_direct', 'zoom2u']);
    });

    it('ranks a fleet without a quote after the quoted ones', () => {
      expect(
        rankFleets(rule(1, 1, 1), [
          candidate('mondapac_drive', null, null, 100),
          candidate('auspost', 4000, 600, 10),
        ]),
      ).toEqual(['auspost', 'mondapac_drive']);
    });
  });

  describe('fixed_priority', () => {
    it('follows the list and leaves out fleets that cannot carry the order', () => {
      const rule: SelectionRule = {
        kind: 'fixed_priority',
        order: ['zoom2u', 'mondapac_drive', 'uber_direct'],
      };
      expect(
        rankFleets(rule, [
          candidate('mondapac_drive', 1, 1),
          candidate('uber_direct', 1, 1),
          candidate('zoom2u', 1, 1),
        ]),
      ).toEqual(['zoom2u', 'mondapac_drive', 'uber_direct']);
      expect(rankFleets(rule, [candidate('uber_direct', null, null)])).toEqual(['uber_direct']);
    });

    it('does not use a fleet that is not on the list', () => {
      const rule: SelectionRule = { kind: 'fixed_priority', order: ['uber_direct'] };
      expect(
        rankFleets(rule, [candidate('mondapac_drive', 1, 1), candidate('auspost', 1, 1)]),
      ).toEqual([]);
    });

    it('is the built-in default when no model is active: own fleet first', () => {
      expect(
        rankFleets(DEFAULT_RULE, [
          candidate('auspost', null, null),
          candidate('zoom2u', null, null),
          candidate('uber_direct', null, null),
          candidate('mondapac_drive', null, null),
        ]),
      ).toEqual(['mondapac_drive', 'uber_direct', 'zoom2u', 'auspost']);
    });
  });

  it('asks for quotes only when the kind needs them', () => {
    expect(needsQuotes({ kind: 'cheapest' })).toBe(true);
    expect(needsQuotes({ kind: 'weighted', weights: { price: 1, eta: 0, reliability: 0 } })).toBe(
      true,
    );
    expect(needsQuotes({ kind: 'fixed_priority', order: ['mondapac_drive'] })).toBe(false);
  });
});

describe('what an admin submits', () => {
  it('accepts a name of 1 to 60 characters and refuses the rest', () => {
    expect(parseModelName('  Cheapest wins ')).toEqual({ ok: true, name: 'Cheapest wins' });
    expect(parseModelName('ارزان‌ترین')).toMatchObject({ ok: true });
    for (const bad of ['', '   ', 'x'.repeat(61), '<b>x</b>', 7, null]) {
      expect(parseModelName(bad)).toEqual({ ok: false, field: { path: 'name', code: 'format' } });
    }
  });

  it('parses the three kinds and nothing else', () => {
    expect(parseSelectionRule({ kind: 'cheapest' })).toEqual({
      ok: true,
      rule: { kind: 'cheapest' },
    });
    expect(
      parseSelectionRule({ kind: 'weighted', weights: { price: 50, eta: 30, reliability: 20 } }),
    ).toEqual({
      ok: true,
      rule: { kind: 'weighted', weights: { price: 50, eta: 30, reliability: 20 } },
    });
    expect(
      parseSelectionRule({ kind: 'fixed_priority', order: ['zoom2u', 'mondapac_drive'] }),
    ).toEqual({
      ok: true,
      rule: { kind: 'fixed_priority', order: ['zoom2u', 'mondapac_drive'] },
    });
    expect(parseSelectionRule({ kind: 'lucky' })).toEqual({
      ok: false,
      fields: [{ path: 'rule.kind', code: 'value' }],
    });
    expect(parseSelectionRule('cheapest')).toEqual({
      ok: false,
      fields: [{ path: 'rule', code: 'format' }],
    });
  });

  it('refuses weights out of range, all zero, missing or unknown', () => {
    const weighted = (weights: unknown) => parseSelectionRule({ kind: 'weighted', weights });
    expect(weighted({ price: 101, eta: 0, reliability: 0 })).toEqual({
      ok: false,
      fields: [{ path: 'rule.weights.price', code: 'range' }],
    });
    expect(weighted({ price: 1.5, eta: 0, reliability: 0 })).toMatchObject({ ok: false });
    expect(weighted({ price: 0, eta: 0, reliability: 0 })).toEqual({
      ok: false,
      fields: [{ path: 'rule.weights', code: 'zero-sum' }],
    });
    expect(weighted({ price: 1, eta: 1 })).toEqual({
      ok: false,
      fields: [{ path: 'rule.weights.reliability', code: 'range' }],
    });
    expect(weighted({ price: 1, eta: 0, reliability: 0, speed: 5 })).toEqual({
      ok: false,
      fields: [{ path: 'rule.weights.speed', code: 'unknown-field' }],
    });
    expect(parseSelectionRule({ kind: 'weighted' })).toEqual({
      ok: false,
      fields: [{ path: 'rule.weights', code: 'format' }],
    });
  });

  it('refuses a fleet list that is empty, unknown or repeats a fleet, and a stray field', () => {
    const order = (value: unknown) => parseSelectionRule({ kind: 'fixed_priority', order: value });
    expect(order([])).toEqual({ ok: false, fields: [{ path: 'rule.order', code: 'range' }] });
    expect(order(['fedex'])).toEqual({
      ok: false,
      fields: [{ path: 'rule.order', code: 'value' }],
    });
    expect(order(['zoom2u', 'zoom2u'])).toEqual({
      ok: false,
      fields: [{ path: 'rule.order', code: 'duplicate' }],
    });
    expect(parseSelectionRule({ kind: 'cheapest', order: [] })).toEqual({
      ok: false,
      fields: [{ path: 'rule.order', code: 'unknown-field' }],
    });
  });

  it('takes a reliability score of a whole number from 0 to 100', () => {
    expect(parseReliability(0)).toBe(0);
    expect(parseReliability(100)).toBe(100);
    for (const bad of [-1, 101, 50.5, '50', null, Number.NaN]) {
      expect(parseReliability(bad)).toBeNull();
    }
  });
});
