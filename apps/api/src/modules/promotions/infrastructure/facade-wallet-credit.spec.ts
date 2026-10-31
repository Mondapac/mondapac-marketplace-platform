import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import type { WalletFacade } from '../../wallet';
import { FacadeWalletCredit } from './facade-wallet-credit';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

// How promotions reads the wallet's answers: a refusal that no retry will change is final (the
// credit is FAILED and its budget freed); anything else is worth a retry. The wallet's own codes.
describe.each(TEST_MARKETS)('the wallet credit adapter in market %s', (code) => {
  const context = (marketCode: string): CallContext =>
    testCallContext(testMarketContext(marketCode, 'default'), 'system', 'wallet-credit-abcdef');
  const request = (currency: string) => ({
    accountId: id<'Account'>(1),
    amount: money(500n, currency),
    orderId: id<'Order'>(2),
    idempotencyKey: 'promotions:cashback:abcdef12',
  });
  const adapterAnswering = (answer: ReturnType<WalletFacade['grantCredit']>) => {
    const calls: unknown[] = [];
    const wallet = {
      grantCredit: (_context: CallContext, input: unknown) => {
        calls.push(input);
        return answer;
      },
    } as unknown as WalletFacade;
    return { adapter: new FacadeWalletCredit(wallet), calls };
  };

  it('passes the credit as promo money with the reason promotion and returns the journal', async () => {
    const { adapter, calls } = adapterAnswering(Promise.resolve(ok({ journalId: 'j-1' })) as never);
    const result = await adapter.grant(context(code), request('AUD'));
    expect(result).toEqual(ok({ journalId: 'j-1' }));
    expect(calls[0]).toMatchObject({
      source: 'promo',
      reasonCode: 'promotion',
      idempotencyKey: 'promotions:cashback:abcdef12',
    });
  });

  it.each([
    'wallet.account-not-active',
    'wallet.cap-exceeded',
    'validation.failed',
    'idempotency.key-reused',
    'wallet.customer-not-found',
    'wallet.not-found',
  ])('treats %s as final', async (refusal) => {
    const { adapter } = adapterAnswering(Promise.resolve(err({ code: refusal })) as never);
    expect(await adapter.grant(context(code), request('AUD'))).toEqual(
      err({ retry: false, code: refusal }),
    );
  });

  it.each(['wallet.unavailable', 'wallet.paused', 'wallet.frozen', 'something.unexpected'])(
    'treats %s as worth a retry',
    async (refusal) => {
      const { adapter } = adapterAnswering(Promise.resolve(err({ code: refusal })) as never);
      expect(await adapter.grant(context(code), request('AUD'))).toEqual(
        err({ retry: true, code: refusal }),
      );
    },
  );
});
