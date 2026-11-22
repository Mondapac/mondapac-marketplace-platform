import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { CertificationFacade } from '../../certification';
import { CertificationClaimTermsCandidateMatcher } from './certification-claim-terms-candidate-matcher';

// The binding of `certification.matchCandidateClaimTerms` (request X-1), on both Market fixtures:
// the context and candidate go through unchanged, a yes or no per text comes back, a refusal of
// the terms is passed on, and every other refusal, fault or odd answer is unavailable.
const UNAVAILABLE = { ok: false, error: { code: 'claim-text.check-unavailable' } };

describe.each(['AU', 'ZZ'] as const)('CertificationClaimTermsCandidateMatcher in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: '0192b3c4-0000-7000-8000-000000000001' as never,
      sessionId: '0192b3c4-0000-7000-8000-000000000002' as never,
      sellerId: null,
    }),
  );
  const candidate = { typeCode: 'zorbex', termsByLocale: { en: ['zorbex'] } };
  const texts = [
    { locale: 'en', text: 'one' },
    { locale: 'en', text: 'two' },
  ];

  function rig(answer: () => unknown) {
    const calls: { context: CallContext; candidate: unknown; texts: unknown }[] = [];
    const facade = {
      matchCandidateClaimTerms: (c: CallContext, cand: unknown, t: unknown) => {
        calls.push({ context: c, candidate: cand, texts: t });
        return Promise.resolve(answer());
      },
    } as unknown as CertificationFacade;
    return { matcher: new CertificationClaimTermsCandidateMatcher(facade), calls };
  }

  it('passes the context and candidate unchanged and answers a yes or no per text', async () => {
    const { matcher, calls } = rig(() =>
      ok([[{ typeCode: 'zorbex', pass: 'token', span: { fromToken: 0, toToken: 1 } }], []]),
    );
    const result = await matcher.matches(context, candidate, [
      { locale: 'en', text: 'one', extra: 'dropped' } as never,
      texts[1]!,
    ]);
    expect(calls[0]?.context).toBe(context);
    expect(calls[0]?.candidate).toBe(candidate);
    expect(calls[0]?.texts).toEqual(texts);
    expect(result).toEqual({ ok: true, value: [true, false] });
  });

  it('passes on a refusal of the terms with paths and codes only', async () => {
    const { matcher } = rig(() =>
      err({
        code: 'validation.failed',
        fields: [{ path: 'termsByLocale.en', code: 'unmatchable', value: 'secret' }],
      }),
    );
    expect(await matcher.matches(context, candidate, texts)).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: 'termsByLocale.en', code: 'unmatchable' }],
      },
    });
  });

  it('passes on an access refusal', async () => {
    const { matcher } = rig(() => err({ code: 'access.denied' }));
    expect(await matcher.matches(context, candidate, texts)).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it('is unavailable on an unavailable answer, a fault, or an answer of the wrong shape', async () => {
    const answers: (() => unknown)[] = [
      () => err({ code: 'certification.unavailable' }),
      () => {
        throw new Error('boom');
      },
      () => ok([[]]), // wrong length
      () => ok([[], 'x']),
      () => ok('nope'),
    ];
    for (const answer of answers) {
      const { matcher } = rig(answer);
      expect(await matcher.matches(context, candidate, texts)).toEqual(UNAVAILABLE);
    }
  });
});
