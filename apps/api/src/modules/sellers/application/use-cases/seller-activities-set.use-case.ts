import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_BUSINESS_ACTIVITY_MANAGE } from '../../contracts/permissions';
import { BusinessActivitiesChanged } from '../../domain/audit';
import {
  allActivityIds,
  parseActivityChange,
  sameAssignment,
  type ActivityFieldProblem,
  type StoredActivityAssignment,
} from '../../domain/seller-business-activities';
import type { BusinessActivityDirectory } from '../ports/business-activity-directory';
import type { SellerBusinessActivityRepository } from '../ports/seller-business-activity.repository';

/** The seller from the path and the body as it came: `{ mainActivityId, extraActivityIds, reason }`. */
export interface SellerActivitiesSetInput {
  readonly sellerId?: unknown;
  readonly body?: unknown;
}

export interface SellerActivitiesSetResult {
  readonly mainActivityId: string;
  readonly extraActivityIds: readonly string[];
  /** False when the seller already carried exactly this set: nothing was written. */
  readonly changed: boolean;
}

export type SellerActivitiesSetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly ActivityFieldProblem[];
    };

export interface SellerActivitiesSetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly businessActivities: SellerBusinessActivityRepository;
  readonly activityDirectory: BusinessActivityDirectory;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * `sellers.seller-activities-set` (ADR-0040 decision 4; package 4a): a Platform Administrator
 * replaces the whole set of business activities a seller carries: exactly one main activity, 0 to
 * 9 distinct extras, and a reason of 1 to 300 characters. Rule `permissions
 * [sellers.business-activity.manage]`, admin population only. Every activity must exist and be
 * ACTIVE in the context's Market, asked through catalog's contract before the write unit opens
 * (any doubt refuses: fail closed). One read-write unit: the seller's setting row is locked, the
 * set is replaced, a row is added to the change log (who, when, from what to what, and the
 * reason) and an audit row (ids only) is written. A repeat of the set the seller already carries
 * writes nothing. A seller with no activity is allowed to exist; nothing here removes the last one.
 */
export class SellerActivitiesSetUseCase extends UseCase<
  SellerActivitiesSetInput,
  SellerActivitiesSetResult,
  SellerActivitiesSetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-activities-set',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_ACTIVITY_MANAGE.key] },
  };

  readonly #logger = new Logger('SellerActivitiesSet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerActivitiesSetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerActivitiesSetInput,
  ): Promise<Result<SellerActivitiesSetResult, SellerActivitiesSetFailure>> {
    const result = await this.set(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.seller-activities-set',
      code: result.ok ? (result.value.changed ? 'changed' : 'unchanged') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async set(
    context: CallContext,
    input: SellerActivitiesSetInput,
  ): Promise<Result<SellerActivitiesSetResult, SellerActivitiesSetFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;

    const parsed = parseActivityChange(input.body);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.error });
    const { assignment, reason } = parsed.value;

    // Catalog opens a read-only unit of its own, so no unit is open while asking.
    const requested = allActivityIds(assignment);
    const active = await this.deps.activityDirectory.activeIds(context, requested);
    if (!active.ok) return err({ code: 'sellers.unavailable' });
    const fields: ActivityFieldProblem[] = [];
    if (!active.value.has(assignment.mainActivityId)) {
      fields.push({ path: 'mainActivityId', code: 'not-active' });
    }
    assignment.extraActivityIds.forEach((id, index) => {
      if (!active.value.has(id))
        fields.push({ path: `extraActivityIds.${index}`, code: 'not-active' });
    });
    if (fields.length > 0) return err({ code: 'validation.failed', fields });

    const { unitOfWork, businessActivities, audit, ids, clock } = this.deps;
    return unitOfWork.run<SellerActivitiesSetResult, SellerActivitiesSetFailure>(
      market,
      async () => {
        if (!(await businessActivities.lock(market, sellerId))) {
          return err({ code: 'file.not-found' });
        }
        const before: StoredActivityAssignment = (
          await businessActivities.find(market, [sellerId])
        ).get(sellerId) ?? { mainActivityId: null, extraActivityIds: [] };
        const shown = {
          mainActivityId: assignment.mainActivityId,
          extraActivityIds: assignment.extraActivityIds,
          changed: false,
        };
        if (sameAssignment(before, assignment)) return ok(shown);
        const at = clock.now();
        await businessActivities.replace(market, sellerId, {
          ...assignment,
          by: actor.accountId,
          at,
        });
        await businessActivities.appendChange(market, {
          id: ids.next<'SellerActivityChange'>(),
          sellerId,
          by: actor.accountId,
          at,
          reason,
          before,
          after: assignment,
        });
        await audit.record(
          context,
          BusinessActivitiesChanged.entry(sellerId, {
            before: {
              mainActivityId: before.mainActivityId,
              extraActivityIds: before.extraActivityIds,
            },
            after: assignment,
          }),
        );
        return ok({ ...shown, changed: true });
      },
    );
  }
}
