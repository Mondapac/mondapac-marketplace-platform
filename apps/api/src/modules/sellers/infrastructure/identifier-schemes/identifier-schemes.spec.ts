import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { MarketId } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  IDENTIFIER_INPUT_MAX_LENGTH,
  parseBusinessIdentifier,
} from '../../domain/business-identifier';
import { abnScheme } from './abn';
import {
  IDENTIFIER_SCHEME_ADAPTERS,
  MarketConfigIdentifierSchemes,
  UnknownIdentifierSchemeError,
} from './index';
import { zzCorpNoScheme } from './zz-corp-no';

// The two identifier schemes and their selection by Market configuration (sellers design 4.1,
// 4.2; AC 3). Run for both Market fixtures: a value valid in one scheme is refused in the other.

const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const registry = new MarketRegistry(configs);

describe('abn scheme', () => {
  it.each(['51824753556', '48123123124', '53004085616'])('accepts %s', (value) => {
    expect(abnScheme.validate(value)).toEqual({ ok: true, value: undefined });
  });

  it('normalises spaces, hyphens, dots and full-width digits, and shows groups of 2-3-3-3', () => {
    expect(abnScheme.normalise(' 51 824 753 556 ')).toBe('51824753556');
    expect(abnScheme.normalise('51-824.753-556')).toBe('51824753556');
    expect(abnScheme.normalise('５１８２４７５３５５６')).toBe('51824753556');
    expect(abnScheme.display('51824753556')).toBe('51 824 753 556');
  });

  it('refuses a wrong length or a non-digit as format, a bad weighted sum as checksum', () => {
    for (const text of [
      '',
      '5182475355',
      '518247535566',
      '5182475355a',
      'ABN51824753556',
      '٥١٨٢٤٧٥٣٥٥٦',
    ]) {
      expect(abnScheme.validate(abnScheme.normalise(text))).toEqual({
        ok: false,
        error: 'identifier.format',
      });
    }
    expect(abnScheme.validate('51824753557')).toEqual({ ok: false, error: 'identifier.checksum' });
    expect(abnScheme.validate('12345678901')).toEqual({ ok: false, error: 'identifier.checksum' });
  });

  it('does not throw on any text and leaves an invalid value unformatted', () => {
    for (const text of ['\u0000', '\ud800', 'x'.repeat(10_000), '１２'.repeat(40), '\n\t ']) {
      expect(() => abnScheme.validate(abnScheme.normalise(text))).not.toThrow();
    }
    expect(abnScheme.display('not a number')).toBe('not a number');
  });
});

describe('zz-corp-no scheme', () => {
  it.each(['123456782', '046454286'])('accepts %s', (value) => {
    expect(zzCorpNoScheme.validate(value)).toEqual({ ok: true, value: undefined });
  });

  it('normalises and shows groups of three', () => {
    expect(zzCorpNoScheme.normalise('123-456 782')).toBe('123456782');
    expect(zzCorpNoScheme.display('123456782')).toBe('123-456-782');
  });

  it('refuses a wrong length as format and a bad Luhn digit as checksum', () => {
    expect(zzCorpNoScheme.validate('12345678')).toEqual({ ok: false, error: 'identifier.format' });
    expect(zzCorpNoScheme.validate('1234567822')).toEqual({
      ok: false,
      error: 'identifier.format',
    });
    expect(zzCorpNoScheme.validate('12345678x')).toEqual({ ok: false, error: 'identifier.format' });
    expect(zzCorpNoScheme.validate('123456789')).toEqual({
      ok: false,
      error: 'identifier.checksum',
    });
  });
});

describe('a value valid in one scheme is refused in the other (AC 3)', () => {
  it('the ABN-like number is a format error in zz-corp-no, and the company number in abn', () => {
    expect(parseBusinessIdentifier('51 824 753 556', zzCorpNoScheme)).toEqual({
      ok: false,
      error: 'identifier.format',
    });
    expect(parseBusinessIdentifier('123-456-782', abnScheme)).toEqual({
      ok: false,
      error: 'identifier.format',
    });
  });
});

describe('parseBusinessIdentifier', () => {
  it('returns the scheme code and the normalised value', () => {
    expect(parseBusinessIdentifier('51 824 753 556', abnScheme)).toEqual({
      ok: true,
      value: { scheme: 'abn', value: '51824753556' },
    });
  });

  it('refuses a non-string and an input above the bound before the scheme sees it', () => {
    for (const raw of [undefined, null, 51824753556, {}, ['51824753556']]) {
      expect(parseBusinessIdentifier(raw, abnScheme)).toEqual({
        ok: false,
        error: 'identifier.format',
      });
    }
    expect(parseBusinessIdentifier('1'.repeat(65), abnScheme)).toEqual({
      ok: false,
      error: 'identifier.format',
    });
  });
});

describe('MarketConfigIdentifierSchemes (start-up check, design 4.2)', () => {
  it.each([
    ['AU', 'abn'],
    ['ZZ', 'zz-corp-no'],
  ] as const)('%s uses its configured scheme %s', (marketId, scheme) => {
    const schemes = new MarketConfigIdentifierSchemes(registry);
    expect(schemes.schemeOf(testMarketContext(marketId, 'default'))?.scheme).toBe(scheme);
    expect(configs.get(marketId as MarketId)?.sellers?.businessIdentifier.scheme).toBe(scheme);
    expect(IDENTIFIER_SCHEME_ADAPTERS.has(scheme)).toBe(true);
  });

  it('refuses to start when a hosted Market names a scheme with no adapter', () => {
    const au = configs.get('AU' as MarketId)!;
    const broken = new MarketRegistry(
      new Map([
        [
          'AU' as MarketId,
          {
            ...au,
            sellers: {
              ...au.sellers!,
              businessIdentifier: { ...au.sellers!.businessIdentifier, scheme: 'no-such-scheme' },
            },
          },
        ],
      ]),
    );
    expect(() => new MarketConfigIdentifierSchemes(broken)).toThrow(UnknownIdentifierSchemeError);
    expect(() => new MarketConfigIdentifierSchemes(broken)).toThrow(/no-such-scheme/);
  });

  it('answers null for a Market the registry does not know and never falls back', () => {
    const schemes = new MarketConfigIdentifierSchemes(registry);
    expect(schemes.schemeOf(testMarketContext('QQ', 'default'))).toBeNull();
  });
});

describe('scheme contract: the normalised value fits the ciphertext bound', () => {
  // identifier_ciphertext is sized for IDENTIFIER_INPUT_MAX_LENGTH characters (data design 4.5).
  const samples = [
    '51824753556',
    '123456782',
    '046454286',
    '９'.repeat(IDENTIFIER_INPUT_MAX_LENGTH),
    '1'.repeat(IDENTIFIER_INPUT_MAX_LENGTH),
    '1 '.repeat(IDENTIFIER_INPUT_MAX_LENGTH / 2),
    '😀'.repeat(IDENTIFIER_INPUT_MAX_LENGTH),
  ];
  it.each([...IDENTIFIER_SCHEME_ADAPTERS.entries()])('%s', (_code, scheme) => {
    for (const text of samples) {
      const parsed = parseBusinessIdentifier(text, scheme);
      if (parsed.ok) {
        expect([...parsed.value.value].length).toBeLessThanOrEqual(IDENTIFIER_INPUT_MAX_LENGTH);
      }
    }
  });
});
