import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { reservedWordsOf } from './reserved-words';
import { parseShopSlug } from './shop-slug';
import { claimWordsIn } from './store-name';

// The reserved words are Market data: each Market fixture is checked with its own list, and
// the other Market's claim words must not leak in (CLAUDE.md: two Market fixtures).

const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const wordsOf = (code: string) => {
  const lists = [...markets.values()].find((m) => m.code === code)?.sellers?.reservedWords;
  if (!lists) throw new Error(`no reserved words for ${code}`);
  return reservedWordsOf(lists);
};

describe('reserved words of the Market fixtures', () => {
  const au = wordsOf('AU');
  const zz = wordsOf('ZZ');

  it('AU refuses its own claim words and platform names, in a slug and as a store name flag', () => {
    for (const slug of [
      'halal',
      'kosher',
      'organic',
      'authentic',
      'best-vegan-shop',
      'mondapac-support',
      'shop',
    ]) {
      expect(parseShopSlug(slug, au)).toEqual({ ok: false, error: { code: 'slug.reserved' } });
    }
    expect(claimWordsIn('MondaPac Support, Halal', au)).toEqual(['mondapac', 'halal']);
  });

  it('ZZ refuses its own words and accepts the AU ones', () => {
    for (const slug of ['blessed', 'zz-staff', 'pure-goods', 'zzmart-help']) {
      expect(parseShopSlug(slug, zz)).toEqual({ ok: false, error: { code: 'slug.reserved' } });
    }
    for (const slug of ['halal', 'shop', 'green-grocer']) {
      expect(parseShopSlug(slug, zz).ok).toBe(true);
    }
    expect(claimWordsIn('Halal Blessed', zz)).toEqual(['blessed']);
  });
});
