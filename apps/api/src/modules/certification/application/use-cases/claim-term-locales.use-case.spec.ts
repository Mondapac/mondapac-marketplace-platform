import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { ClaimVocabularyEntry } from '../../domain/claim-text-matcher';
import type { CertificationTypeCode } from '../../domain/claim-types';
import type { PublishedTypesReader } from '../ports/published-types.reader';
import { ClaimTermLocales } from './claim-term-locales.use-case';

const code = (s: string): CertificationTypeCode => s as CertificationTypeCode;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

let vocabulary: readonly ClaimVocabularyEntry[] | Error = [];
const reader: PublishedTypesReader = {
  claimVocabulary: () =>
    vocabulary instanceof Error ? Promise.reject(vocabulary) : Promise.resolve(vocabulary),
  types: () => Promise.resolve([]),
};

describe.each(['AU', 'ZZ'])('certification claim-term locales, Market %s', (marketCode) => {
  const anonymous = () => testCallContext(testMarketContext(marketCode, 'default'), 'anonymous');
  const useCase = new ClaimTermLocales(gate, reader);

  it('answers the locales every type has a term in, sorted', async () => {
    vocabulary = [
      { typeCode: code('halal'), terms: ['halal', 'حلال'], termLocales: ['fa-IR', 'en-AU'] },
      { typeCode: code('kosher'), terms: ['kosher'], termLocales: ['en-AU', 'ja-JP'] },
    ];
    await expect(useCase.execute(anonymous(), {})).resolves.toEqual({ ok: true, value: ['en-AU'] });
  });

  it('is unavailable, never "all covered", for a missing or incomplete vocabulary', async () => {
    const unavailable = { ok: false, error: { code: 'certification.unavailable' } };
    for (const broken of [
      [],
      [{ typeCode: code('halal'), terms: [], termLocales: [] }],
      [{ typeCode: code('halal'), terms: ['halal'] }],
      new Error('db down'),
    ]) {
      vocabulary = broken;
      await expect(useCase.execute(anonymous(), {})).resolves.toEqual(unavailable);
    }
  });
});
