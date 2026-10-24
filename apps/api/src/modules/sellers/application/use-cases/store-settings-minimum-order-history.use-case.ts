import { err, ok, parseId, parseMinorUnits, parseMoney } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditTrailEntry,
  AuditTrailReader,
} from '../../../../platform/audit/audit-trail-reader';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_STORE_SETTINGS_EDIT } from '../../contracts/permissions';
import { MinimumOrderChanged } from '../../domain/audit';
import type { DraftValidationFailed } from '../draft/draft-view';
import { logDraftOutcome, sellerActorOf } from '../draft/draft-support';
import { identityReadFailure } from '../ports/seller-account-directory';
import type { StoreProfileRepository } from '../ports/store-profile.repository';
import type { TeamMemberLabel, TeamMemberLabelSource } from '../ports/team-member-labels';
import { storeSettingsLogger, type StoreSettingsFailure } from '../store-settings/store-settings';

/** The page size when the request names none, and the largest it may name. */
export const MINIMUM_ORDER_HISTORY_PAGE = 20;
export const MAX_MINIMUM_ORDER_HISTORY_PAGE = 50;

export interface MinimumOrderHistoryInput {
  /** The `next` of the previous page; absent or null for the first page. */
  readonly after?: unknown;
  readonly limit?: unknown;
}

/** One change of the minimum order: when, who, and the value before and after (null: none). */
export interface MinimumOrderChangeView {
  readonly changedAt: Temporal.Instant;
  /** A current member of the seller's team; null for a former member (or anyone else). */
  readonly changedBy: TeamMemberLabel | null;
  readonly before: Money | null;
  readonly after: Money | null;
}

export interface MinimumOrderHistoryPage {
  /** Newest first. */
  readonly items: readonly MinimumOrderChangeView[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: string | null;
}

export type MinimumOrderHistoryFailure = StoreSettingsFailure | DraftValidationFailed;

export interface MinimumOrderHistoryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly storeProfiles: StoreProfileRepository;
  readonly auditTrail: AuditTrailReader;
  readonly teamMembers: TeamMemberLabelSource;
}

const invalid = (path: string, code: string): DraftValidationFailed => ({
  code: 'validation.failed',
  fields: [{ path, code }],
});

/** A side of a `sellers.minimum-order.changed` row as the writer encoded it (W4), or null. */
function minimumOrderOf(side: unknown): Money | null {
  if (typeof side !== 'object' || side === null) return null;
  const value = (side as { readonly minimumOrder?: unknown }).minimumOrder;
  if (typeof value !== 'object' || value === null) return null;
  const { amount, currency } = value as { readonly amount?: unknown; readonly currency?: unknown };
  const minor = parseMinorUnits(amount);
  if (!minor.ok) return null;
  const parsed = parseMoney(minor.value, currency);
  return parsed.ok ? parsed.value : null;
}

/**
 * `store-settings.minimum-order-history` (seller operations P-E; design 18 decision 8): the
 * changes of the seller's own minimum order, newest first, from its `sellers.minimum-order.changed`
 * audit rows, with who made each one. Rule `permissions [sellers.store-settings.edit]`, approved
 * sellers only, the same as the settings it explains; the seller is `ActorContext.sellerId`, never
 * an id from the request.
 *
 * The rows are read in one read-only unit through sellers' own audit reader (platform-audit 10),
 * after the profile read that refuses a seller that is not approved. The actor ids are then named
 * through `identity` (`teamMemberLabels`, outside the unit): a current member of the actor's own
 * team gets name and role; anyone else (a former member, an admin) is `changedBy: null`, so no
 * admin id or other account reaches the seller (PA 10, Hassan I4). The read writes no audit row:
 * the values are the seller's own public commercial terms, not personal data (design 9). The log
 * line carries the outcome and counts, never a name.
 */
export class StoreSettingsMinimumOrderHistory extends UseCase<
  MinimumOrderHistoryInput,
  MinimumOrderHistoryPage,
  MinimumOrderHistoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-settings-minimum-order-history',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_SETTINGS_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MinimumOrderHistoryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MinimumOrderHistoryInput,
  ): Promise<Result<MinimumOrderHistoryPage, MinimumOrderHistoryFailure>> {
    const result = await this.read(context, input ?? {});
    logDraftOutcome(
      'store-settings-minimum-order-history',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'read' : result.error.code,
    );
    return result;
  }

  private async read(
    context: CallContext,
    input: MinimumOrderHistoryInput,
  ): Promise<Result<MinimumOrderHistoryPage, MinimumOrderHistoryFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const limit = input.limit ?? MINIMUM_ORDER_HISTORY_PAGE;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_MINIMUM_ORDER_HISTORY_PAGE
    ) {
      return err(invalid('limit', 'range'));
    }
    let after: string | null = null;
    if (input.after !== undefined && input.after !== null) {
      const parsed = typeof input.after === 'string' ? parseId(input.after) : null;
      if (parsed === null || !parsed.ok) return err(invalid('after', 'format'));
      after = parsed.value;
    }
    const { market } = context;

    let rows: readonly AuditTrailEntry[];
    try {
      const read = await this.deps.unitOfWork.run<
        readonly AuditTrailEntry[],
        MinimumOrderHistoryFailure
      >(
        market,
        async () => {
          const profile = await this.deps.storeProfiles.find(market, owner.sellerId);
          if (profile === null) return err({ code: 'file.not-found' });
          if (!profile.approved) return err({ code: 'access.denied' });
          // One row more than the page tells whether another page exists.
          const history = await this.deps.auditTrail.history(market, {
            action: MinimumOrderChanged.action,
            targetId: owner.sellerId,
            after,
            limit: limit + 1,
          });
          return history.ok ? history : err(invalid('after', 'unknown'));
        },
        { readOnly: true },
      );
      if (!read.ok) return read;
      rows = read.value;
    } catch (error) {
      return this.unavailable(context, error);
    }

    const page = rows.slice(0, limit);
    const actorIds = [
      ...new Set(
        page.flatMap((row) =>
          row.actorType === 'USER' && row.actorId !== null ? [row.actorId as Id<'Account'>] : [],
        ),
      ),
    ];
    let labels: ReadonlyMap<Id<'Account'>, TeamMemberLabel>;
    try {
      labels = await this.deps.teamMembers.labelsOf(context, actorIds);
    } catch (error) {
      const failure = identityReadFailure(error);
      if (failure.code === 'sellers.unavailable') return this.unavailable(context, error);
      return err(failure);
    }
    return ok({
      items: page.map((row) => ({
        changedAt: row.occurredAt,
        changedBy:
          row.actorType === 'USER' && row.actorId !== null
            ? (labels.get(row.actorId as Id<'Account'>) ?? null)
            : null,
        before: minimumOrderOf(row.before),
        after: minimumOrderOf(row.after),
      })),
      next: rows.length > limit ? page[page.length - 1]!.id : null,
    });
  }

  private unavailable(
    context: CallContext,
    error: unknown,
  ): Result<never, { readonly code: 'sellers.unavailable' }> {
    storeSettingsLogger.error({
      msg: 'sellers.store-settings-minimum-order-history.failed',
      error: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'sellers.unavailable' });
  }
}
