import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  viewMyHistory,
  type CustomerWalletFailure,
  type HistoryInput,
  type HistoryView,
} from '../customer-flow';
import type { WalletDependencies } from '../wallet-dependencies';

export type { HistoryView };

/** `wallet.view-my-history`: the signed-in customer reads their own wallet (rule `own-resources`; reads work in an acting-as session). */
export class ViewMyHistory extends UseCase<HistoryInput, HistoryView, CustomerWalletFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.view-my-history',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: HistoryInput) {
    return viewMyHistory(this.deps, context, input);
  }
}
