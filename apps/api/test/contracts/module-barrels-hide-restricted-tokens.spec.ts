import { readdirSync } from 'node:fs';
import path from 'node:path';
import { APPROVED_SELLER_ZONES } from '../../src/modules/sellers/contracts/approved-seller-zones.contract';

// Hassan M1: no module public barrel (src/modules/<module>/index.ts, and the contracts barrel
// it re-exports) may export the value APPROVED_SELLER_ZONES, at any re-export depth. Checked on
// loaded values, so `export *` chains are followed. The dependency-cruiser rule restricts who
// imports the contract file; this restricts what the barrels hand out.

const MODULES = path.resolve(__dirname, '../../src/modules');

const MAX_DEPTH = 5;

/** True when the token is a value of the barrel, or nested in an object, array or Map value. */
function exposes(value: unknown, depth = 0, seen = new Set<unknown>()): boolean {
  if (value === APPROVED_SELLER_ZONES) return true;
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH || seen.has(value)) {
    return false;
  }
  seen.add(value);
  const children =
    value instanceof Map
      ? [...value.keys(), ...value.values()]
      : value instanceof Set
        ? [...value]
        : Object.values(value);
  return children.some((child) => exposes(child, depth + 1, seen));
}

const barrels = readdirSync(MODULES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => [`${entry.name}/index`, `${entry.name}/contracts/index`])
  .filter((barrel) => {
    try {
      require.resolve(path.join(MODULES, barrel));
      return true;
    } catch {
      return false;
    }
  });

describe('module barrels do not export APPROVED_SELLER_ZONES', () => {
  it('finds the barrels, including certification and the sellers contracts barrel', () => {
    expect(barrels).toEqual(
      expect.arrayContaining([
        'certification/index',
        'sellers/index',
        'sellers/contracts/index',
        'identity/index',
      ]),
    );
  });

  it.each(barrels)('%s exports no value equal to the token', (barrel) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loads each barrel
    const loaded = require(path.join(MODULES, barrel)) as Record<string, unknown>;

    expect(exposes(loaded)).toBe(false);
  });

  it('would catch a barrel that re-exports the token (negative control)', () => {
    expect(exposes({ SomethingElse: 1, ...{ Renamed: APPROVED_SELLER_ZONES } })).toBe(true);
  });

  it('would catch the token nested in an object, an array and a Map, and survive a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(exposes({ zones: APPROVED_SELLER_ZONES })).toBe(true);
    expect(exposes({ list: [1, [APPROVED_SELLER_ZONES]] })).toBe(true);
    expect(exposes({ map: new Map([['k', { deep: APPROVED_SELLER_ZONES }]]) })).toBe(true);
    expect(exposes(cyclic)).toBe(false);
  });
});
