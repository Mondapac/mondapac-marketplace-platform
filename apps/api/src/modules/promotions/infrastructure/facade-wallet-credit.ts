import { err, ok } from '@mondapac/shared-kernel';
import type { WalletFacade } from '../../wallet';
import type { WalletCredit } from '../application/ports/wallet-credit';

/** The wallet's refusals that no retry will change. */
const FINAL = new Set([
  'wallet.account-not-active',
  'wallet.cap-exceeded',
  'validation.failed',
  'idempotency.key-reused',
  // The account has no wallet and none will appear by waiting.
  'wallet.customer-not-found',
  'wallet.not-found',
]);

/**
 * {@link WalletCredit} on `wallet`'s public facade: promo credit with the reason `promotion`. The
 * wallet's own idempotency makes a repeated call with the same key answer the first result. A
 * refusal the wallet will repeat (its account is closed, unknown or over its cap) is final; everything else
 * (the wallet is off, paused, frozen or unavailable, or an unknown answer) is worth a retry.
 */
export class FacadeWalletCredit implements WalletCredit {
  constructor(private readonly wallet: WalletFacade) {}

  async grant(
    ...[context, request]: Parameters<WalletCredit['grant']>
  ): ReturnType<WalletCredit['grant']> {
    const granted = await this.wallet.grantCredit(context, {
      customerAccountId: request.accountId,
      source: 'promo',
      amount: request.amount,
      reasonCode: 'promotion',
      ...(request.orderId === null ? {} : { orderId: request.orderId }),
      idempotencyKey: request.idempotencyKey,
    });
    if (granted.ok) return ok({ journalId: granted.value.journalId });
    const code = granted.error.code;
    return err({ retry: !FINAL.has(code), code });
  }
}
