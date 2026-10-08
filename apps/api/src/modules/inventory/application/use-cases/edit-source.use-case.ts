import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { INVENTORY_SOURCE_EDIT } from '../../contracts/permissions';
import type { SellerInventory } from '../../domain/seller-inventory';
import type { InventoryPolicyProvider } from '../ports/inventory-policy-provider';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import {
  checkSourceBody,
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

export interface EditSourceInput {
  readonly expectedVersion: number;
  readonly sourceId: string;
  readonly name: string;
  /** An object of text fields, or null. */
  readonly address: Readonly<Record<string, string>> | null;
  /** An IANA zone id, or null for the seller's own zone. */
  readonly timeZone: string | null;
}

export type EditSourceFailure =
  | ValidationFailed
  | SellerNotReady
  | { readonly code: 'access.denied' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'inventory.source.not-found' };

export interface EditSourceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly policies: InventoryPolicyProvider;
}

/**
 * `inventory.edit-source` (inventory design 3.4, 6; UX F29 step 6, D12): changes one stock
 * location's name, address and time zone (the whole form is sent). The Default may be renamed,
 * never removed or replaced. A source of another seller is not in the seller's inventory, so it
 * answers `inventory.source.not-found` like an unknown id (AC 11). A save that changes nothing
 * writes nothing and keeps the version. The seller comes from the actor; `expectedVersion` is the version the screen read, and a
 * mismatch is `conflict.stale`, checked first. The name, address and zone are **personal data**: they never enter a log line or an
 * audit row, and a validation answer names paths and rule codes only.
 */
export class EditSource extends UseCase<EditSourceInput, SourcesView, EditSourceFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.edit-source',
    rule: { kind: 'permissions', allOf: [INVENTORY_SOURCE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('EditSource');

  constructor(
    gate: UseCaseGate,
    private readonly deps: EditSourceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: EditSourceInput,
  ): Promise<Result<SourcesView, EditSourceFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const fields: { path: string; code: string }[] = [];
    const expectedVersion = checkVersion(input?.expectedVersion, fields);
    const sourceId = checkSourceId(input?.sourceId, 'sourceId', fields);
    const body = checkSourceBody(input, fields);
    if (fields.length > 0 || body === null || sourceId === null) return validationFailed(fields);
    const checked = { expectedVersion, sourceId, ...body };
    const max = this.deps.policies.maxSourcesPerSeller(market);
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SourcesView, EditSourceFailure>> => {
        const inventory = await this.deps.inventories.findBySeller(market, sellerId);
        if (inventory === null) return err(NOT_READY);
        if (inventory.state.version !== checked.expectedVersion) return err(STALE);
        const edited = inventory.editSource({
          sourceId: checked.sourceId,
          name: checked.name,
          address: checked.address,
          timeZone: checked.timeZone,
        });
        if (!edited.ok) return err(edited.error);
        const changed: SellerInventory = edited.value;
        if (changed.persistedVersion === null || changed === inventory) {
          return ok(sourcesViewOf(inventory, max));
        }
        if ((await this.deps.inventories.save(market, changed)) === 'stale') return err(STALE);
        return ok(sourcesViewOf(changed, max));
      },
    );
    if (!result.ok) {
      this.#logger.log({
        msg: 'inventory.edit-source.refused',
        code: result.error.code,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return result;
    }
    this.#logger.log({
      msg: 'inventory.edit-source.done',
      version: result.value.version,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
