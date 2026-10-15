import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { OfferNamesSystemQuery } from './offer-names-system.use-case';

describe.each([['AU'], ['ZZ']] as const)('catalog.offer-names-system in market %s', (code) => {
  it('refuses a customer, a seller, an admin and an anonymous caller', async () => {
    const query = new OfferNamesSystemQuery(openGate(), undefined as never);
    await expectSystemOnly(code, (context) =>
      query.execute(context, { offerIds: [], locale: 'en-AU' }),
    );
  });
});
