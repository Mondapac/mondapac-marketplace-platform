import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { INVENTORY_SOURCE_EDIT } from '../../contracts/permissions';
import type { SellerInventory } from '../../domain/seller-inventory';
import type { InventoryPolicyProvider } from '../ports/inventory-policy-provider';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import {
  checkSourceBody,
  checkVersion,
  NOT_READY,
  sellerOf,
  STALE,
  validationFailed,
  type SellerNotReady,
  type ValidationFailed,
} from '../source-use-case-support';
import { sourcesViewOf, type SourcesView } from '../sources-view';

export interface CreateSourceInput {
  readonly expectedVersion: number;
  readonly name: string;
  /** An object of text fields, or null. */
  readonly address: Readonly<Record<string, string>> | null;
  /** An IANA zone id, or null for the seller's own zone. */
  readonly timeZone: string | null;
}

export type CreateSourceFailure =
  | ValidationFailed
  | SellerNotReady
  | { readonly code: 'access.denied' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'inventory.sources.limit-reached';
      readonly details: { readonly max: number };
    };

export interface CreateSourceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly policies: InventoryPolicyProvider;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * `inventory.create-source` (inventory design 3.4, 6; UX F29 step 3, D12): appends a stock location
 * last. The seller comes from the actor; `expectedVersion` is the version the screen read, and a
 * mismatch is `conflict.stale`. Refused with `inventory.sources.limit-reached` (details: `max`)
 * when the seller already has the Market's limit, the Default included. The name, address and
 * zone are the seller's text and **personal data**: they never enter a log line or an audit row;
 * a validation answer names paths and rule codes only. The check order is the version first (a
 * stale screen is told so), then the limit.
 */
export class CreateSource extends UseCase<CreateSourceInput, SourcesView, CreateSourceFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.create-source',
    rule: { kind: 'permissions', allOf: [INVENTORY_SOURCE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('CreateSource');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CreateSourceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CreateSourceInput,
  ): Promise<Result<SourcesView, CreateSourceFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const fields: { path: string; code: string }[] = [];
    const expectedVersion = checkVersion(input?.expectedVersion, fields);
    const body = checkSourceBody(input, fields);
    if (fields.length > 0 || body === null) return validationFailed(fields);
    const checked = { expectedVersion, ...body };
    const max = this.deps.policies.maxSourcesPerSeller(market);
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SourcesView, CreateSourceFailure>> => {
        const inventory = await this.deps.inventories.findBySeller(market, sellerId);
        if (inventory === null) return err(NOT_READY);
        if (inventory.state.version !== checked.expectedVersion) return err(STALE);
        const added = inventory.addSource({
          id: this.deps.ids.next<'InventorySource'>(),
          name: checked.name,
          address: checked.address,
          timeZone: checked.timeZone,
          maxSources: max,
          now: this.deps.clock.now(),
        });
        if (!added.ok) {
          return err({
            code: 'inventory.sources.limit-reached',
            details: { max: added.error.max },
          } as const);
        }
        const changed: SellerInventory = added.value;
        if (changed.persistedVersion === null || changed === inventory) {
          return ok(sourcesViewOf(inventory, max));
        }
        if ((await this.deps.inventories.save(market, changed)) === 'stale') return err(STALE);
        return ok(sourcesViewOf(changed, max));
      },
    );
    if (!result.ok) {
      this.#logger.log({
        msg: 'inventory.create-source.refused',
        code: result.error.code,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return result;
    }
    this.#logger.log({
      msg: 'inventory.create-source.done',
      version: result.value.version,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
