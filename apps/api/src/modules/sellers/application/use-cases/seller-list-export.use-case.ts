import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import {
  exportSellers,
  type SellerSuperListDependencies,
  type SellerSuperListFailure,
  type SellerSuperListInput,
} from '../seller-super-list-flow';

/**
 * `sellers.seller-list-export` (super list 15): an admin exports the sellers the list shows, as a
 * CSV or XLSX file. Same key as the list (`sellers.seller.view`); the status and the owner's name
 * and email are filled only for a caller that also holds `identity.seller-access.view`.
 */
export class SellerListExport extends UseCase<
  SellerSuperListInput,
  ExportFile,
  SellerSuperListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-list-export',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerSuperListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerSuperListInput) {
    return exportSellers(this.deps, context, input);
  }
}
