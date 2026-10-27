import { ok, parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// The open-obligations count of an account (account deletion) runs on the real store: the order
// and refund filters are valid SQL and an account with nothing open counts zero, per Market.
// Order and refund states are covered in the use-case spec and the refund db spec.

const ACCOUNT = (() => {
  const parsed = parseId('01990000-0000-7000-8000-00000000f0f0');
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Account'>;
})();

describe.each(TEST_MARKETS)('open obligations store in market %s (database)', (code) => {
  let db: Persistence;
  beforeAll(() => {
    db = createPersistence();
  });
  afterAll(async () => {
    await db.close();
  });

  it('counts nothing for an account without orders', async () => {
    const market = marketOf(code);
    const counted = await db.unitOfWork.run(
      market,
      async () => ok(await new PrismaOrderRepository(db.service).countOpenOf(market, ACCOUNT)),
      { readOnly: true },
    );
    expect(counted).toEqual({ ok: true, value: { openOrders: 0, pendingRefunds: 0 } });
  });
});
