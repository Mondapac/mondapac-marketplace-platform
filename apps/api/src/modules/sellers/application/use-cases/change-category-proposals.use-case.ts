import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { derivedId } from '../../../../platform/hashing/derived-id';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_SETTINGS_EDIT } from '../../contracts/permissions';
import { CategoryProposalsChanged } from '../../domain/audit';
import {
  SellerCategoryProposalsGranted,
  SellerCategoryProposalsRevoked,
} from '../../domain/events';
import type { CategoryProposalsSettingRepository } from '../ports/category-proposals-setting.repository';

/** The seller from the path and the body as it came: `{ allowed }`. */
export interface ChangeCategoryProposalsInput {
  readonly sellerId?: unknown;
  readonly body?: unknown;
}

export interface ChangeCategoryProposalsResult {
  readonly allowed: boolean;
  /**
   * False when the switch already held the value: no audit row and no event (the row lock still
   * raised the settings row's version).
   */
  readonly changed: boolean;
}

export type ChangeCategoryProposalsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    };

export interface ChangeCategoryProposalsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categoryProposalsSetting: CategoryProposalsSettingRepository;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

const BODY_KEYS = ['allowed'] as const;

/**
 * `sellers.change-category-proposals` (sellers design 6.2 `seller-settings.change-category-proposals`; SEL-26): an admin
 * allows a seller to propose categories, or takes it away. Rule
 * `permissions [sellers.seller-settings.edit]` (platform scope, not protected); admin population
 * only. One read-write unit: the settings row is locked, the switch is set with who and when, the
 * audit row `sellers.category-proposals.changed` is written and the event
 * `sellers.category-proposals-granted.v1` or `-revoked.v1` goes to the outbox. `catalog` consumes
 * the revoke and cancels the seller's pending proposals in its own unit (CAT-51). A repeat of the
 * value already held is `changed: false` with no audit row and no event (the lock still raised
 * the row's version). Rule for the shared aggregate: at most one `seller-admin-settings` event
 * per version bump, so the product-types and AI events can share it later. An unknown seller and another
 * Market's seller are both `file.not-found`.
 */
export class ChangeCategoryProposalsUseCase extends UseCase<
  ChangeCategoryProposalsInput,
  ChangeCategoryProposalsResult,
  ChangeCategoryProposalsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.change-category-proposals',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_SETTINGS_EDIT.key] },
  };

  readonly #logger = new Logger('ChangeCategoryProposals');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeCategoryProposalsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangeCategoryProposalsInput,
  ): Promise<Result<ChangeCategoryProposalsResult, ChangeCategoryProposalsFailure>> {
    const result = await this.change(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.change-category-proposals',
      code: result.ok ? (result.value.changed ? 'changed' : 'unchanged') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async change(
    context: CallContext,
    input: ChangeCategoryProposalsInput,
  ): Promise<Result<ChangeCategoryProposalsResult, ChangeCategoryProposalsFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;

    const body = input.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return err({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
    }
    const fields: { path: string; code: string }[] = [];
    for (const key of Object.keys(body).sort()) {
      if (!(BODY_KEYS as readonly string[]).includes(key)) {
        fields.push({ path: key.slice(0, 64), code: 'unknown-field' });
      }
    }
    const { allowed } = body as Record<string, unknown>;
    if (typeof allowed !== 'boolean') {
      fields.push({ path: 'allowed', code: allowed === undefined ? 'required' : 'type' });
    }
    if (fields.length > 0 || typeof allowed !== 'boolean') {
      return err({ code: 'validation.failed', fields });
    }

    const { unitOfWork, categoryProposalsSetting, audit, outbox, clock } = this.deps;
    return unitOfWork.run<ChangeCategoryProposalsResult, ChangeCategoryProposalsFailure>(
      market,
      async () => {
        const state = await categoryProposalsSetting.lock(market, sellerId);
        if (state === null) return err({ code: 'file.not-found' });
        if (state.allowed === allowed) return ok({ allowed, changed: false });
        const now = clock.now();
        await categoryProposalsSetting.set(market, sellerId, {
          allowed,
          by: actor.accountId,
          at: now,
        });
        await audit.record(
          context,
          CategoryProposalsChanged.entry(sellerId, {
            before: { enabled: state.allowed },
            after: { enabled: allowed },
          }),
        );
        const event = allowed ? SellerCategoryProposalsGranted : SellerCategoryProposalsRevoked;
        await outbox.append(context, [
          event.record({
            aggregateId: derivedId<'SellerAdminSettings'>('seller-admin-settings', sellerId),
            aggregateVersion: state.version,
            occurredAt: now,
            payload: { sellerId },
          }),
        ]);
        return ok({ allowed, changed: true });
      },
    );
  }
}
