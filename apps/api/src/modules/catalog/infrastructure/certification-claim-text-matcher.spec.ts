import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { CertificationFacade } from '../../certification';
import { CertificationClaimTextMatcher } from './certification-claim-text-matcher';

// The binding of `certification.matchClaimTerms` (ADR-0031 decision 3), on both Market fixtures:
// the context goes through unchanged, only the type code and span are kept, and every refusal,
// fault or odd answer is unavailable.
const UNAVAILABLE = { ok: false, error: { code: 'claim-text.check-unavailable' } };

describe.each(['AU', 'ZZ'] as const)('CertificationClaimTextMatcher in market %s', (code) => {
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
  const texts = [
    { locale: 'en', text: 'one' },
    { locale: 'en', text: 'two' },
  ];

  function rig(answer: () => unknown) {
    const calls: { context: CallContext; texts: unknown }[] = [];
    const facade = {
      matchClaimTerms: (c: CallContext, t: unknown) => {
        calls.push({ context: c, texts: t });
        return Promise.resolve(answer());
      },
    } as unknown as CertificationFacade;
    return { matcher: new CertificationClaimTextMatcher(facade), calls };
  }

  it('passes the context unchanged and keeps only the type code and the span', async () => {
    const { matcher, calls } = rig(() =>
      ok([
        [{ typeCode: 'halal', pass: 'token', span: { fromToken: 1, toToken: 2 }, extra: 'x' }],
        [{ typeCode: 'kosher', pass: 'compact', span: null }],
      ]),
    );
    const result = await matcher.match(context, [
      { field: 'product.name', ref: 'secret', locale: 'en', text: 'one' },
      { field: 'product.name', ref: null, locale: 'ar', text: 'two' },
    ] as never);
    expect(calls[0]?.context).toBe(context);
    expect(calls[0]?.texts).toEqual([
      { locale: 'en', text: 'one' },
      { locale: 'ar', text: 'two' },
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        [{ typeCode: 'halal', span: { fromToken: 1, toToken: 2 } }],
        [{ typeCode: 'kosher', span: null }],
      ],
    });
  });

  it.each([
    ['a refusal', () => err({ code: 'access.denied' })],
    ['an unavailable read', () => err({ code: 'certification.unavailable' })],
    ['a validation failure', () => err({ code: 'validation.failed', fields: [] })],
    ['an answer of the wrong length', () => ok([[]])],
    ['an inner list that is null', () => ok([null, []])],
    ['a match without a type code', () => ok([[{ span: null }], []])],
    ['a match with an undefined span', () => ok([[{ typeCode: 'halal' }], []])],
    [
      'a span with a bad index',
      () => ok([[{ typeCode: 'halal', span: { fromToken: -1, toToken: 2 } }], []]),
    ],
    [
      'a thrown fault',
      () => {
        throw new Error('down');
      },
    ],
  ])('answers unavailable for %s', async (_name, answer) => {
    const failing = rig(answer);
    expect(await failing.matcher.match(context, texts)).toEqual(UNAVAILABLE);
  });

  it('answers an empty list for no texts', async () => {
    const { matcher } = rig(() => ok([]));
    expect(await matcher.match(context, [])).toEqual({ ok: true, value: [] });
  });
});
