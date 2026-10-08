import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SellerInventory } from '../../domain/seller-inventory';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';

/** One delivery of `identity.seller-registered.v1` (inventory design 3.4, 7.4). */
export interface EnsureSellerInventoryInput {
  readonly delivery: EventDelivery;
  readonly sellerId: Id;
  /** The seller's access state in the event; only `approved` creates an inventory. */
  readonly accessState: string;
}

export type EnsureSellerInventoryOutput =
  | { readonly code: 'seller-inventory.created' }
  | { readonly code: 'seller-inventory.exists' }
  | { readonly code: 'seller-inventory.already-handled' }
  | { readonly code: 'seller-inventory.not-approved' };

export type EnsureSellerInventoryFailure = { readonly code: 'access.denied' };

export interface EnsureSellerInventoryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The handler `inventory.ensure-seller-inventory` (inventory design 3.4, 6; SEL-10; slice 1).
 * Rule `system`, from the subscription on `identity.seller-registered.v1`. An approved seller
 * gets a `SellerInventory` with its Default source (priority 1, no address, no zone) in one unit,
 * through `runOnce`. A seller that is not approved yet gets nothing: the inventory is created
 * when the approval arrives (`identity.seller-access-approved.v1`, which identity does not
 * publish yet; the handler gains that subscription with it).
 *
 * Idempotent twice over: the inbox skips an event this handler already handled, and the unique
 * (Market, seller) key makes a second approval, re-apply or reinstatement a no-op
 * (`seller-inventory.exists`, AC 10). Never in `identity`'s transaction (ADR-0004 decision 5).
 * No log line holds more than ids, codes and counts.
 */
export class EnsureSellerInventory extends UseCase<
  EnsureSellerInventoryInput,
  EnsureSellerInventoryOutput,
  EnsureSellerInventoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.ensure-seller-inventory',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('EnsureSellerInventory');

  constructor(
    gate: UseCaseGate,
    private readonly deps: EnsureSellerInventoryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: EnsureSellerInventoryInput,
  ): Promise<Result<EnsureSellerInventoryOutput, EnsureSellerInventoryFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, inventories, ids, clock } = this.deps;

    // The state check sits inside `runOnce`: a delivery that creates nothing is still settled
    // (inbox row, delivery delivered), or the dispatcher would retry it into a dead letter.
    const handled = await unitOfWork.runOnce(market, input.delivery, async () => {
      if (input.accessState !== 'approved') return ok('not-approved' as const);
      const inventory = SellerInventory.createWithDefaultSource({
        id: ids.next<'SellerInventory'>(),
        defaultSourceId: ids.next<'InventorySource'>(),
        sellerId: input.sellerId as Id<'Seller'>,
        marketId: market.marketId,
        now: clock.now(),
      });
      return ok(
        (await inventories.add(market, inventory)) ? ('created' as const) : ('exists' as const),
      );
    });
    if (!handled.ok) throw new Error('ensure-seller-inventory: the unit failed');

    const output: EnsureSellerInventoryOutput = !handled.value.handled
      ? { code: 'seller-inventory.already-handled' }
      : { code: `seller-inventory.${handled.value.value}` };
    this.#logger.log({
      msg: `inventory.${output.code}`,
      sellerId: input.sellerId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
