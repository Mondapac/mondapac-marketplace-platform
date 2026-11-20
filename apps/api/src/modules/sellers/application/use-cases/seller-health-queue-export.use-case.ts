import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import {
  exportHealthQueue,
  type HealthQueueListDependencies,
  type HealthQueueListFailure,
  type HealthQueueListInput,
} from '../health-queue-list-flow';

/**
 * `sellers.seller-health-queue-export` (super list 16): an admin exports the "Needs a look" queue as
 * the list does. Same key as the older queue (`sellers.seller.view`); it reads the same sellers.
 */
export class SellerHealthQueueExport extends UseCase<
  HealthQueueListInput,
  ExportFile,
  HealthQueueListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-health-queue-export',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: HealthQueueListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: HealthQueueListInput) {
    return exportHealthQueue(this.deps, context, input);
  }
}
