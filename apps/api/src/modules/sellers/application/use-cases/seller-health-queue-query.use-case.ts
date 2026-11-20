import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import {
  listHealthQueue,
  type HealthQueueListDependencies,
  type HealthQueueListFailure,
  type HealthQueueListInput,
  type HealthQueueListPage,
} from '../health-queue-list-flow';

/**
 * `sellers.seller-health-queue-query` (super list 16): an admin lists the "Needs a look" queue as
 * the list does. Same key as the older queue (`sellers.seller.view`); it reads the same sellers.
 */
export class SellerHealthQueueQuery extends UseCase<
  HealthQueueListInput,
  HealthQueueListPage,
  HealthQueueListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-health-queue-query',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: HealthQueueListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: HealthQueueListInput) {
    return listHealthQueue(this.deps, context, input);
  }
}
