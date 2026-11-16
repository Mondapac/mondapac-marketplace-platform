import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../contracts/permissions';
import {
  listSellerLedger,
  type SellerLedgerPage,
  type SellerPageListDependencies,
  type SellerPageListFailure,
} from '../seller-page-lists-flow';

export type { SellerLedgerPage };

type Input = Readonly<Record<string, unknown>>;

/**
 * `commission-payouts.view-seller-ledger`: an admin reads a seller's ledger and balance, as the
 * compact super list of the seller page (list 27).
 */
export class ViewSellerLedger extends UseCase<Input, SellerLedgerPage, SellerPageListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-seller-ledger',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerPageListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listSellerLedger(this.deps, context, input);
  }
}
