import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { INVENTORY_SOURCE_EDIT } from '../../contracts/permissions';
import type { SellerInventory } from '../../domain/seller-inventory';
import type { InventoryPolicyProvider } from '../ports/inventory-policy-provider';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import {
  checkSourceId,
  checkVersion,
  NOT_READY,
  sellerOf,
  STALE,
  validationFailed,
  type SellerNotReady,
  type ValidationFailed,
} from '../source-use-case-support';
import { sourcesViewOf, type SourcesView } from '../sources-view';

export interface ReorderSourcesInput {
  readonly expectedVersion: number;
  /** Every source id of the seller, in the new order (UX F29 step 5: "Save order"). */
  readonly orderedSourceIds: readonly string[];
}

export type ReorderSourcesFailure =
  | ValidationFailed
  | SellerNotReady
  | { readonly code: 'access.denied' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'inventory.sources.order-mismatch' };

export interface ReorderSourcesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly policies: InventoryPolicyProvider;
}

/**
 * `inventory.reorder-sources` (inventory design 3.4, 6; UX F29 step 5): sets the whole order of
 * the seller's stock locations in one request. The list must name every location of the seller
 * exactly once, else `inventory.sources.order-mismatch`; the same order writes nothing and keeps
 * the version. The order decides which location fills an order line first (design 3.1). The seller comes from the actor; `expectedVersion` is the version the screen read, and a
 * mismatch is `conflict.stale`, checked first.
 */
export class ReorderSources extends UseCase<
  ReorderSourcesInput,
  SourcesView,
  ReorderSourcesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.reorder-sources',
    rule: { kind: 'permissions', allOf: [INVENTORY_SOURCE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ReorderSources');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReorderSourcesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReorderSourcesInput,
  ): Promise<Result<SourcesView, ReorderSourcesFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const fields: { path: string; code: string }[] = [];
    const expectedVersion = checkVersion(input?.expectedVersion, fields);
    const raw: unknown = input?.orderedSourceIds;
    const ordered: Id<'InventorySource'>[] = [];
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 5) {
      fields.push({ path: 'orderedSourceIds', code: 'length' });
    } else {
      raw.forEach((entry: unknown, index) => {
        const id = checkSourceId(entry, `orderedSourceIds.${index}`, fields);
        if (id !== null) ordered.push(id);
      });
    }
    if (fields.length > 0) return validationFailed(fields);
    const checked = { expectedVersion, ordered };
    const max = this.deps.policies.maxSourcesPerSeller(market);
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SourcesView, ReorderSourcesFailure>> => {
        const inventory = await this.deps.inventories.findBySeller(market, sellerId);
        if (inventory === null) return err(NOT_READY);
        if (inventory.state.version !== checked.expectedVersion) return err(STALE);
        const reordered = inventory.reorder(checked.ordered);
        if (!reordered.ok) return err(reordered.error);
        const changed: SellerInventory = reordered.value;
        if (changed.persistedVersion === null || changed === inventory) {
          return ok(sourcesViewOf(inventory, max));
        }
        if ((await this.deps.inventories.save(market, changed)) === 'stale') return err(STALE);
        return ok(sourcesViewOf(changed, max));
      },
    );
    if (!result.ok) {
      this.#logger.log({
        msg: 'inventory.reorder-sources.refused',
        code: result.error.code,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return result;
    }
    this.#logger.log({
      msg: 'inventory.reorder-sources.done',
      version: result.value.version,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
