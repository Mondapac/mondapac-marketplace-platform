import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  ClawBackCreditRequest,
  ClawBackCreditResult,
  WalletFailure,
} from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { clawBackCredit } from '../wallet-flow';

/**
 * `wallet.claw-back-credit`: takes back what is left of one promo grant, up to an amount (system
 * caller, through the facade; customers phase 4c, a refund after a cashback). Rule `system`.
 */
export class ClawBackCredit extends UseCase<
  ClawBackCreditRequest,
  ClawBackCreditResult,
  WalletFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.claw-back-credit',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ClawBackCreditRequest) {
    return clawBackCredit(this.deps, context, input);
  }
}
