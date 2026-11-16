import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../contracts/permissions';
import {
  exportSellerHolds,
  type SellerPageExportFailure,
  type SellerPageListDependencies,
} from '../seller-page-lists-flow';

type Input = Readonly<Record<string, unknown>>;

/** `commission-payouts.export-seller-payout-holds`: an admin downloads a seller's payout holds. */
export class ExportSellerPayoutHolds extends UseCase<Input, ExportFile, SellerPageExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.export-seller-payout-holds',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerPageListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return exportSellerHolds(this.deps, context, input);
  }
}
