import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { OrderNoticeQuery } from './order-notice.use-case';

describe.each([['AU'], ['ZZ']] as const)('ordering.order-notice in market %s', (code) => {
  it('refuses a customer, a seller, an admin and an anonymous caller', async () => {
    const query = new OrderNoticeQuery(openGate(), undefined as never);
    await expectSystemOnly(code, (context) =>
      query.execute(context, { orderId: '01990000-0000-7000-8000-000000000001' }),
    );
  });
});
