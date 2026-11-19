import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_HOLD_VIEW } from '../../contracts/permissions';
import {
  exportAdminHolds,
  type AdminHoldListDependencies,
  type HoldExportInput,
  type HoldListFailure,
} from '../admin-hold-list-flow';

/**
 * `pricing.export-price-holds`: the held prices of the list as a CSV or XLSX file (the list's only
 * bulk action: no bulk approve exists, a price decision is made one record at a time). Same key as
 * the list.
 */
export class ExportPriceHolds extends UseCase<HoldExportInput, ExportFile, HoldListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.export-price-holds',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminHoldListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: HoldExportInput) {
    return exportAdminHolds(this.deps, context, input);
  }
}
