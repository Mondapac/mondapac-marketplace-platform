import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CertificationFacade } from '../../certification';
import { CertificationStoreTextClaimCheck } from './certification-store-text-claim-check';
import { LateBoundStoreTextClaimCheck } from './late-bound-store-text-claim-check';

// The claim check of store texts: over certification's matchClaimTerms, fail closed, and refusing
// until it is bound (sellers cannot import certification, so SellerStoreProfileModule binds it).

const context = testCallContext(testMarketContext('AU', 'default'), 'anonymous');
const texts = [
  { locale: 'en-AU', text: 'a' },
  { locale: 'en-AU', text: 'b' },
];
const UNAVAILABLE = { ok: false, error: { code: 'claim-text.check-unavailable' } };

const facade = (matchClaimTerms: () => unknown) =>
  ({ matchClaimTerms }) as unknown as CertificationFacade;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('CertificationStoreTextClaimCheck', () => {
  it('flags the texts that matched a claim term, in order, keeping nothing of the match', async () => {
    const check = new CertificationStoreTextClaimCheck(
      facade(() => Promise.resolve(ok([[], [{ typeCode: 'halal', span: null }]]))),
    );

    expect(await check.flagged(context, texts)).toEqual({ ok: true, value: [false, true] });
  });

  it.each([
    ['a refusal', () => Promise.resolve(err({ code: 'certification.unavailable' }))],
    ['a fault', () => Promise.reject(new Error('down'))],
    ['an answer of the wrong length', () => Promise.resolve(ok([[]]))],
    ['an answer that is not lists', () => Promise.resolve(ok([[], 'x']))],
  ])('is unavailable on %s, never an empty answer', async (_, answer) => {
    const check = new CertificationStoreTextClaimCheck(facade(answer));

    expect(await check.flagged(context, texts)).toEqual(UNAVAILABLE);
  });
});

describe('LateBoundStoreTextClaimCheck', () => {
  it('refuses until a check is bound, then asks it', async () => {
    const late = new LateBoundStoreTextClaimCheck();
    expect(await late.flagged(context, texts)).toEqual(UNAVAILABLE);

    late.bind({ flagged: () => Promise.resolve(ok([true, false])) });

    expect(await late.flagged(context, texts)).toEqual({ ok: true, value: [true, false] });
  });
});
