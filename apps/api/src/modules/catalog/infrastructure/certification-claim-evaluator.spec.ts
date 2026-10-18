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
