import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { INVENTORY_STOCK_VIEW } from '../../contracts/permissions';
import type { InventoryPolicyProvider } from '../ports/inventory-policy-provider';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import { NOT_READY, sellerOf, type SellerNotReady } from '../source-use-case-support';
import { sourcesViewOf, type SourcesView } from '../sources-view';

export type ListSourcesFailure = { readonly code: 'access.denied' } | SellerNotReady;

export interface ListSourcesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly policies: InventoryPolicyProvider;
}

/**
 * `inventory.list-sources` (inventory design 6; UX F29 step 2): the acting seller's stock
 * locations in priority order, with the version and the Market's limit. The seller comes from
 * the actor, never from input. One read-only unit (ADR-0025). A seller whose approval event has
 * not run yet has no inventory: `inventory.not-ready`, which the screen shows as "We're setting
 * up your stock" with "Try again" (UX F29 step 1). **Personal data** in the answer; no log line
 * holds more than ids and counts.
 */
export class ListSources extends UseCase<Record<string, never>, SourcesView, ListSourcesFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.list-sources',
    rule: { kind: 'permissions', allOf: [INVENTORY_STOCK_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ListSources');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListSourcesDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<SourcesView, ListSourcesFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const inventory = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.inventories.findBySeller(market, sellerId)),
      { readOnly: true },
    );
    if (!inventory.ok) throw new Error('inventory.list-sources: a read-only unit failed');
    if (inventory.value === null) {
      this.#logger.log({
        msg: 'inventory.list-sources.not-ready',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(NOT_READY);
    }
    return ok(sourcesViewOf(inventory.value, this.deps.policies.maxSourcesPerSeller(market)));
  }
}
