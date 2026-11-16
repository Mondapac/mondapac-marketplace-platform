import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../contracts/permissions';
import {
  exportSellerLedger,
  type SellerPageExportFailure,
  type SellerPageListDependencies,
} from '../seller-page-lists-flow';

type Input = Readonly<Record<string, unknown>>;

/** `commission-payouts.export-seller-ledger`: an admin downloads a seller's ledger rows. */
export class ExportSellerLedger extends UseCase<Input, ExportFile, SellerPageExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.export-seller-ledger',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerPageListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return exportSellerLedger(this.deps, context, input);
  }
}
