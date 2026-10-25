import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CertificationFacade } from '../../certification';
import { CertificationClaimEvaluator } from './certification-claim-evaluator';

// `typeCodeOf` of catalog's adapter (certification slice 14): the type id of a certification
// event mapped to the code catalog's tags store, through `certificationTypes` of every status. A
// refusal, a fault or a malformed answer is `claim.check-unavailable`, never "no such type".

const TYPE_ID = '0192b3c4-0000-7000-8000-000000000001';

describe.each(['AU', 'ZZ'] as const)(
  'CertificationClaimEvaluator.typeCodeOf, market %s',
  (code) => {
    const context = testCallContext(testMarketContext(code, 'default'), 'system');
    const facade = (answer: () => Promise<unknown>): CertificationFacade =>
      ({ certificationTypes: answer }) as unknown as CertificationFacade;

    beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('answers the code of the type, active or not, and null for an id the Market lacks', async () => {
      let filter: unknown;
      const evaluator = new CertificationClaimEvaluator(
        facade((...args: unknown[]) => {
          filter = (args as [unknown, unknown])[1];
          return Promise.resolve(
            ok([
              { typeId: TYPE_ID, code: 'halal', status: 'inactive' },
              { typeId: '0192b3c4-0000-7000-8000-000000000002', code: 'kosher', status: 'active' },
            ]),
          );
        }),
      );
      expect(await evaluator.typeCodeOf(context, TYPE_ID)).toEqual(ok('halal'));
      expect(filter).toEqual({});
      expect(await evaluator.typeCodeOf(context, '0192b3c4-0000-7000-8000-0000000000ff')).toEqual(
        ok(null),
      );
    });

    it.each([
      ['a refusal', () => Promise.resolve(err({ code: 'access.denied' }))],
      ['a fault', () => Promise.reject(new Error('down'))],
      ['a type without an id', () => Promise.resolve(ok([{ code: 'halal', status: 'active' }]))],
      ['a malformed code', () => Promise.resolve(ok([{ typeId: TYPE_ID, code: 'Not A Code' }]))],
    ])('is unavailable on %s (fail closed)', async (_label, answer) => {
      const evaluator = new CertificationClaimEvaluator(facade(answer));
      expect(await evaluator.typeCodeOf(context, TYPE_ID)).toEqual(
        err({ code: 'claim.check-unavailable' }),
      );
    });
  },
);

// `typeNames` (offer badges): the names of the active types in one locale, by code, with the
// published revision each was read from. A type without a name in that locale is left out; a
// refusal, a fault or a malformed answer is unavailable (fail closed).
describe.each(['AU', 'ZZ'] as const)('CertificationClaimEvaluator.typeNames, market %s', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous');
  const REVISION = '0192b3c4-0000-7000-8000-0000000000a1';
  const facade = (answer: () => Promise<unknown>): CertificationFacade =>
    ({ certificationTypes: answer }) as unknown as CertificationFacade;
  const type = (over: object = {}) => ({
    typeId: TYPE_ID,
    code: 'halal',
    status: 'active',
    publishedRevisionId: REVISION,
    locales: { 'en-AU': { name: 'Halal', customerDescription: 'x' } },
    ...over,
  });

  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('answers the name in the locale with its revision, asking active types only', async () => {
    let filter: unknown;
    const evaluator = new CertificationClaimEvaluator(
      facade((...args: unknown[]) => {
        filter = (args as [unknown, unknown])[1];
        return Promise.resolve(ok([type()]));
      }),
    );
    expect(await evaluator.typeNames(context, 'en-AU')).toEqual(
      ok(new Map([['halal', { typeRevisionId: REVISION, name: 'Halal' }]])),
    );
    expect(filter).toEqual({ status: 'active' });
  });

  it.each([
    ['another locale only', type()],
    ['an empty name', type({ locales: { 'xx-XX': { name: '  ' } } })],
    ['a non-text name', type({ locales: { 'xx-XX': { name: 5 } } })],
    ['an over-long name', type({ locales: { 'xx-XX': { name: 'x'.repeat(201) } } })],
    ['an inherited locale key', type({ locales: {} })],
  ])('leaves the type out for %s (no fallback to another locale)', async (_label, row) => {
    const evaluator = new CertificationClaimEvaluator(facade(() => Promise.resolve(ok([row]))));
    expect(await evaluator.typeNames(context, 'xx-XX')).toEqual(ok(new Map()));
    expect(await evaluator.typeNames(context, 'constructor')).toEqual(ok(new Map()));
  });

  it.each([
    ['a refusal', () => Promise.resolve(err({ code: 'access.denied' }))],
    ['a fault', () => Promise.reject(new Error('down'))],
    ['a malformed code', () => Promise.resolve(ok([type({ code: 'Not A Code' })]))],
    ['an inactive type', () => Promise.resolve(ok([type({ status: 'inactive' })]))],
    ['no revision id', () => Promise.resolve(ok([type({ publishedRevisionId: 'x' })]))],
    ['no locales', () => Promise.resolve(ok([type({ locales: null })]))],
  ])('is unavailable on %s (fail closed)', async (_label, answer) => {
    const evaluator = new CertificationClaimEvaluator(facade(answer));
    expect(await evaluator.typeNames(context, 'en-AU')).toEqual(
      err({ code: 'claim.check-unavailable' }),
    );
  });
});
