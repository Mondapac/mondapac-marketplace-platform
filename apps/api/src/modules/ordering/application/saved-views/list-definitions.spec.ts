import { ADMIN_ORDER_COLUMNS } from './list-definitions';

describe('the admin Orders column vocabulary', () => {
  it('has Payment, and no Status (the status is always shown)', () => {
    expect(ADMIN_ORDER_COLUMNS).toEqual([
      'placed',
      'paid',
      'payment',
      'customer',
      'sellers',
      'total',
    ]);
  });
});
