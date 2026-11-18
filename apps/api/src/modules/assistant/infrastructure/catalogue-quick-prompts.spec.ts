import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_LOCALE_CONFIG_DIRS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  testMarketId,
} from '../../../../test/support/test-config';
import { loadLocaleCatalogues } from '../../../platform/i18n/locale-catalogues';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { CatalogueQuickPrompts, InvalidQuickPromptsError } from './catalogue-quick-prompts';

// The quick prompts from the checked-in catalogues on both Market fixtures (AU en-AU, ZZ ja-JP
// with en-US supported but without an assistant catalogue), and the boot checks.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const AU = testMarketContext(testMarketId('AU'), 'default');
const ZZ = testMarketContext(testMarketId('ZZ'), 'default');

describe('CatalogueQuickPrompts', () => {
  const prompts = new CatalogueQuickPrompts(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));

  it("answers the Market's default locale without a usable language", () => {
    const au = prompts.forBuyer(AU, null);
    expect(au.length).toBeGreaterThan(0);
    expect(au[0]).toMatch(/special/);
    expect(prompts.forBuyer(ZZ, null)[0]).toBe('今週の特売は？');
    for (const bad of ['', 'x', 'en_AU', 'en-AU-' + 'a'.repeat(20), '<script>', 'fa-IR\n']) {
      expect(prompts.forBuyer(AU, bad)).toEqual(au);
    }
  });

  it('uses a supported locale by exact tag or by language, else the default', () => {
    const au = prompts.forBuyer(AU, null);
    expect(prompts.forBuyer(AU, 'en-au')).toEqual(au);
    expect(prompts.forBuyer(AU, 'en-GB')).toEqual(au);
    expect(prompts.forBuyer(AU, 'fa-IR')).toEqual(au);
    expect(prompts.forBuyer(ZZ, 'ja')).toEqual(prompts.forBuyer(ZZ, null));
    // ZZ supports en-US but has no English prompts: the default answers.
    expect(prompts.forBuyer(ZZ, 'en-US')).toEqual(prompts.forBuyer(ZZ, null));
  });

  it('keeps every checked-in prompt short and plain', () => {
    for (const market of [AU, ZZ]) {
      for (const text of prompts.forBuyer(market, null)) {
        expect(Array.from(text).length).toBeLessThanOrEqual(80);
        expect(text).not.toMatch(/[<>\p{Cc}]/u);
      }
    }
  });

  describe('boot checks', () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'assistant-prompts-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const catalogues = (byLocale: Record<string, Record<string, string>>) => {
      for (const [locale, messages] of Object.entries(byLocale)) {
        mkdirSync(path.join(root, locale), { recursive: true });
        writeFileSync(path.join(root, locale, 'assistant.json'), JSON.stringify(messages));
      }
      return loadLocaleCatalogues([root]);
    };

    it("refuses to start when a hosted Market's default locale has no prompt", () => {
      expect(
        () => new CatalogueQuickPrompts(markets, catalogues({ 'en-AU': { 'assistant.x': 'y' } })),
      ).toThrow(InvalidQuickPromptsError);
    });

    it('refuses a prompt over 80 characters', () => {
      const long = { 'assistant.quick-prompt.1': 'a'.repeat(81) };
      expect(
        () => new CatalogueQuickPrompts(markets, catalogues({ 'en-AU': long, 'ja-JP': long })),
      ).toThrow(/over 80/);
    });

    it('reads prompts in order and stops at the first gap, at most six', () => {
      const messages: Record<string, string> = {};
      for (const n of [1, 2, 4, 5, 6, 7]) messages[`assistant.quick-prompt.${n}`] = `p${n}`;
      const read = new CatalogueQuickPrompts(
        markets,
        catalogues({ 'en-AU': messages, 'ja-JP': messages }),
      );
      expect(read.forBuyer(AU, null)).toEqual(['p1', 'p2']);
      const seven: Record<string, string> = {};
      for (let n = 1; n <= 7; n++) seven[`assistant.quick-prompt.${n}`] = `p${n}`;
      rmSync(root, { recursive: true, force: true });
      const full = new CatalogueQuickPrompts(
        markets,
        catalogues({ 'en-AU': seven, 'ja-JP': seven }),
      );
      expect(full.forBuyer(AU, null)).toHaveLength(6);
    });
  });
});
