import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
  testMarketId,
} from '../../../test/support/test-config';
import { InvalidServiceAreaConfigError, loadServiceAreas } from './service-area-config';

const AU = testMarketId('AU');
const ZZ = testMarketId('ZZ');
const QQ = testMarketId('QQ');

function directoryWith(files: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'areas-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      path.join(directory, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return directory;
}

const area = (code: string, postcodes: string[], open = true) => ({
  code,
  postcodes,
  sellerOnboardingEnabled: open,
  deliveryEnabled: open,
});

describe('ServiceAreaDirectory', () => {
  const directory = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);

  it('finds the launch area of the launch market, closed until the owner opens it', () => {
    expect(directory.areaFor(AU, '4000')).toEqual({
      code: 'greater-brisbane',
      sellerOnboardingEnabled: false,
      deliveryEnabled: false,
    });
    expect(directory.areaFor(AU, ' 4179 ')?.code).toBe('greater-brisbane');
  });

  it('answers none for a postcode no area lists', () => {
    expect(directory.areaFor(AU, '2000')).toBeUndefined();
    expect(directory.areaFor(AU, '')).toBeUndefined();
    expect(directory.areaFor(AU, '4180')).toBeUndefined();
  });

  it('works for the synthetic market: long digits, letters, independent flags', () => {
    expect(directory.areaFor(ZZ, '1000001')).toMatchObject({
      code: 'zz-central',
      sellerOnboardingEnabled: true,
    });
    expect(directory.areaFor(ZZ, 'zz1 9aa')?.code).toBe('zz-central');
    expect(directory.areaFor(ZZ, '2000500')).toEqual({
      code: 'zz-coast',
      sellerOnboardingEnabled: false,
      deliveryEnabled: true,
    });
  });

  it('never matches across markets or lengths', () => {
    expect(directory.areaFor(ZZ, '4000')).toBeUndefined();
    expect(directory.areaFor(AU, '1000001')).toBeUndefined();
    expect(directory.areaFor(AU, '04000')).toBeUndefined();
    expect(directory.areaFor(QQ, '4000')).toBeUndefined();
  });

  it('lists the areas of a market', () => {
    expect(directory.areasOf(ZZ).map((a) => a.code)).toEqual(['zz-central', 'zz-coast']);
    expect(directory.areasOf(QQ)).toEqual([]);
  });
});

describe('loadServiceAreas', () => {
  it('requires a file for every hosted market', () => {
    const dir = directoryWith({});
    expect(() => loadServiceAreas([dir], [AU])).toThrow(/no service-area file/);
  });

  it('rejects invalid JSON, unknown keys, a wrong market and a bad code', () => {
    expect(() => loadServiceAreas([directoryWith({ 'AU.json': '{' })], [AU])).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      loadServiceAreas([directoryWith({ 'AU.json': { market: 'AU', areas: [], extra: 1 } })], [AU]),
    ).toThrow(InvalidServiceAreaConfigError);
    expect(() =>
      loadServiceAreas([directoryWith({ 'AU.json': { market: 'ZZ', areas: [] } })], [AU]),
    ).toThrow(/must match the file name/);
    expect(() =>
      loadServiceAreas(
        [directoryWith({ 'AU.json': { market: 'AU', areas: [area('Bad Code', ['4000'])] } })],
        [AU],
      ),
    ).toThrow(/code/);
  });

  it('rejects a range with ends of different length or in the wrong order, and junk', () => {
    for (const bad of ['400-4179', '4179-4000', '40 00!', '12345678901234']) {
      expect(() =>
        loadServiceAreas(
          [directoryWith({ 'AU.json': { market: 'AU', areas: [area('a', [bad])] } })],
          [AU],
        ),
      ).toThrow(InvalidServiceAreaConfigError);
    }
  });

  it('rejects a duplicate code and a postcode two areas claim', () => {
    expect(() =>
      loadServiceAreas(
        [
          directoryWith({
            'AU.json': { market: 'AU', areas: [area('a', ['4000']), area('a', ['4001'])] },
          }),
        ],
        [AU],
      ),
    ).toThrow(/twice/);
    expect(() =>
      loadServiceAreas(
        [
          directoryWith({
            'AU.json': { market: 'AU', areas: [area('a', ['4000-4100']), area('b', ['4100'])] },
          }),
        ],
        [AU],
      ),
    ).toThrow(/shares a postcode/);
    expect(() =>
      loadServiceAreas(
        [
          directoryWith({
            'AU.json': { market: 'AU', areas: [area('a', ['AB1']), area('b', ['ab 1'])] },
          }),
        ],
        [AU],
      ),
    ).toThrow(/shares a postcode/);
  });

  it('refuses one market configured in two directories', () => {
    const a = directoryWith({ 'AU.json': { market: 'AU', areas: [] } });
    const b = directoryWith({ 'AU.json': { market: 'AU', areas: [] } });
    expect(() => loadServiceAreas([a, b], [AU])).toThrow(/twice/);
  });

  it('ignores files of markets that are not hosted', () => {
    const dir = directoryWith({ 'AU.json': { market: 'AU', areas: [] }, 'ZZ.json': '{' });
    expect(() => loadServiceAreas([dir], [AU])).not.toThrow();
  });
});
