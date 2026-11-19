import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { ShipmentListPage } from '../../domain/admin-shipment-list';
import {
  listShipments,
  type AdminShipmentListDependencies,
  type ShipmentListInput,
} from '../admin-shipment-list-flow';
import type { ReadFailure } from '../read-flow';

/**
 * The seller orders of the Market's paid orders, for the admin Shipments list (rule `permissions
 * [ordering.order.view]`: the same seller orders an admin can already open on the order page).
 */
export class AdminListShipments extends UseCase<ShipmentListInput, ShipmentListPage, ReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-list-shipments',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminShipmentListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ShipmentListInput) {
    return listShipments(this.deps, context, input);
  }
}
