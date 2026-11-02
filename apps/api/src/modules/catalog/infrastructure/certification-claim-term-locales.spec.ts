import { err, ok } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { CertificationClaimTermLocales } from './certification-claim-term-locales';

const facade = (answer: () => Promise<unknown>): CertificationFacade =>
  ({ claimTermLocales: answer }) as unknown as CertificationFacade;

describe.each(['AU', 'ZZ'] as const)('CertificationClaimTermLocales (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const context = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: '01990000-0000-7000-8000-0000000000a1' as never,
      sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
      sellerId: null,
    }),
  );

  it('copies the locales the facade answers', async () => {
    const adapter = new CertificationClaimTermLocales(
      facade(() => Promise.resolve(ok(['en-AU', 'fa']))),
    );
    await expect(adapter.covered(context)).resolves.toEqual(ok(['en-AU', 'fa']));
  });

  it.each([
    ['a refusal', () => Promise.resolve(err({ code: 'certification.unavailable' }))],
    ['a fault', () => Promise.reject(new Error('down'))],
    ['a non-list', () => Promise.resolve(ok('en-AU'))],
    ['a malformed tag', () => Promise.resolve(ok(['en AU']))],
    ['a non-string', () => Promise.resolve(ok([1]))],
    ['nothing', () => Promise.resolve(undefined)],
  ])('reads %s as unavailable', async (_case, answer) => {
    const adapter = new CertificationClaimTermLocales(facade(answer));
    await expect(adapter.covered(context)).resolves.toEqual(
      err({ code: 'claim-text.check-unavailable' }),
    );
  });
});
