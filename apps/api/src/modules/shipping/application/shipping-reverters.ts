import type { CallContext } from '@mondapac/shared-kernel';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import { revertDeliverySettings, revertSellerDeliveryMethods } from './delivery-settings-flow';
import { revertFleetSelection, revertFleetSelectionModel } from './fleet-selection-flow';
import type { ShippingDependencies } from './shipping-dependencies';

// The reverters of area delivery (see shipping-review.ts): each restores the value before a
// rejected or withdrawn change, in the open unit of that decision, only while the subject still
// holds the value after the change.

/** `shipping.delivery-settings`: the Market's delivery settings. */
export class DeliverySettingsReverter implements SystemChangeReverter {
  constructor(private readonly deps: ShippingDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertDeliverySettings(this.deps, context, request);
  }
}

/** `shipping.seller-delivery-methods`: the methods a seller supports. */
export class SellerDeliveryMethodsReverter implements SystemChangeReverter {
  constructor(private readonly deps: ShippingDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertSellerDeliveryMethods(this.deps, context, request);
  }
}

/** `shipping.fleet-selection`: the active model per method and the reliability scores. */
export class FleetSelectionReverter implements SystemChangeReverter {
  constructor(private readonly deps: ShippingDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertFleetSelection(this.deps, context, request);
  }
}

/** `shipping.fleet-selection-model`: the name and rule of one model. */
export class FleetSelectionModelReverter implements SystemChangeReverter {
  constructor(private readonly deps: ShippingDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertFleetSelectionModel(this.deps, context, request);
  }
}
