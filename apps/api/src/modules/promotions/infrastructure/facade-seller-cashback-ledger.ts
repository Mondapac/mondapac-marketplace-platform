import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { SellerCashbackLedger } from '../application/ports/seller-cashback-ledger';

/** {@link SellerCashbackLedger} on `commission-payouts`' facade (system actor only). */
export class FacadeSellerCashbackLedger implements SellerCashbackLedger {
  constructor(private readonly commission: CommissionPayoutsFacade) {}

  async record(
    ...[context, cashback]: Parameters<SellerCashbackLedger['record']>
  ): Promise<boolean> {
    if (context.actor.kind !== 'system') return false;
    try {
      const recorded = await this.commission.recordSellerCashback(context, cashback);
      return recorded.ok;
    } catch {
      return false;
    }
  }

  async recordReturn(
    ...[context, returned]: Parameters<SellerCashbackLedger['recordReturn']>
  ): Promise<boolean> {
    if (context.actor.kind !== 'system') return false;
    try {
      const recorded = await this.commission.recordSellerCashbackReturn(context, returned);
      return recorded.ok;
    } catch {
      return false;
    }
  }
}
