import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  GrantCreditRequest,
  GrantCreditResult,
  WalletFailure,
} from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { grantCredit } from '../wallet-flow';

/** `wallet.grant-credit`: Grants store credit to a customer wallet (system caller, through the facade). Rule `system`. */
export class GrantCredit extends UseCase<GrantCreditRequest, GrantCreditResult, WalletFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.grant-credit',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: GrantCreditRequest) {
    return grantCredit(this.deps, context, input);
  }
}
