import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { WalletFailure } from '../../contracts/wallet.facade';
import { expireDue, type ExpiryReport } from '../expiry-flow';
import type { WalletDependencies } from '../wallet-dependencies';

/**
 * `wallet.expire-wallet-credit`: the worker's sweep. Releases holds past their expiry and moves
 * expired promo lots to breakage income. Rule `system`; runs in every wallet state except off.
 */
export class ExpireWalletCredit extends UseCase<
  Record<string, never>,
  ExpiryReport,
  WalletFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.expire-wallet-credit',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return expireDue(this.deps, context);
  }
}
