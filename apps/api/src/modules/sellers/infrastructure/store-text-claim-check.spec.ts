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

const facade = (matchClaimTerms: () => unknown, claimTermList: () => unknown = () => undefined) =>
  ({ matchClaimTerms, claimTermList }) as unknown as CertificationFacade;
const termsOf = () => Promise.resolve(ok(['halal']));

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

describe('CertificationStoreTextClaimCheck terms', () => {
  it('passes the claim terms of certification on, a copy', async () => {
    const list = ['halal', 'halal certified'];
    const check = new CertificationStoreTextClaimCheck(
      facade(
        () => undefined,
        () => Promise.resolve(ok(list)),
      ),
    );

    const answer = await check.terms(context);

    expect(answer).toEqual({ ok: true, value: list });
    expect(answer.ok && answer.value).not.toBe(list);
  });

  it.each([
    ['a refusal', () => Promise.resolve(err({ code: 'certification.unavailable' }))],
    ['a fault', () => Promise.reject(new Error('down'))],
    ['an empty list', () => Promise.resolve(ok([]))],
    ['a list with a non-text', () => Promise.resolve(ok(['halal', 3]))],
    ['an answer that is not a list', () => Promise.resolve(ok('halal'))],
  ])('is unavailable on %s, never an empty list', async (_, answer) => {
    const check = new CertificationStoreTextClaimCheck(facade(() => undefined, answer));

    expect(await check.terms(context)).toEqual(UNAVAILABLE);
  });
});

describe('LateBoundStoreTextClaimCheck', () => {
  it('refuses until a check is bound, then asks it', async () => {
    const late = new LateBoundStoreTextClaimCheck();
    expect(await late.flagged(context, texts)).toEqual(UNAVAILABLE);
    expect(await late.terms(context)).toEqual(UNAVAILABLE);

    late.bind({ flagged: () => Promise.resolve(ok([true, false])), terms: termsOf });

    expect(await late.flagged(context, texts)).toEqual({ ok: true, value: [true, false] });
  });

  it('binds once: a second bind throws and keeps the first check (Hassan H3)', async () => {
    const late = new LateBoundStoreTextClaimCheck();
    late.bind({ flagged: () => Promise.resolve(ok([true, false])), terms: termsOf });

    expect(() =>
      late.bind({ flagged: () => Promise.resolve(ok([false, false])), terms: termsOf }),
    ).toThrow('already bound');
    expect(await late.flagged(context, texts)).toEqual({ ok: true, value: [true, false] });
  });
});
