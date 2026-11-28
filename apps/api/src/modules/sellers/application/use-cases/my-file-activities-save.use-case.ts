import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import {
  allActivityIds,
  parseActivityRequest,
  type ActivityAssignment,
  type ActivityFieldProblem,
} from '../../domain/seller-business-activities';
import {
  fileExists,
  logDraftOutcome,
  reserveRateLimits,
  sellerActorOf,
  type AccessUnavailable,
  type DraftAccessDenied,
  type RequestThrottled,
  type SellersUnavailable,
} from '../draft/draft-support';
import type { DraftValidationFailed, FileNotFound } from '../draft/draft-view';
import type { BusinessActivityDirectory } from '../ports/business-activity-directory';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerActivityRequestRepository } from '../ports/seller-activity-request.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

// The seller's own choice of business activities during setup (BUG-012 step 2; ADR-0040 decision
// 4: chosen at sign-up, approved in review). The choice is a REQUEST kept in its own table: it never
// changes what the seller carries. The reviewer reads it on the seller page and applies it, or
// another set, with the admin change (which has a reason and a step-up).

/** The body as it came: `{ mainActivityId, extraActivityIds }`. */
export type MyActivitiesSaveInput = { readonly body?: unknown };

export interface MyActivitiesSaved extends ActivityAssignment {
  /** False when the seller already asked for exactly this set: nothing was written. */
  readonly changed: boolean;
}

export type MyActivitiesSaveFailure =
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | FileNotFound
  | DraftValidationFailed;

export interface MyActivitiesSaveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly activityRequests: SellerActivityRequestRepository;
  readonly activityDirectory: BusinessActivityDirectory;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `my-file.activities-save`: the Seller Owner asks for one main business activity and 0 to 9
 * extras. Rule `permissions [sellers.business-identity.edit]`, allowed while the seller is not
 * approved. In order: the owner is `ActorContext.sellerId`; the saves limit is reserved; the body is
 * read (closed, ids only); every activity must be ACTIVE in the context's Market, asked through
 * catalog's contract before the write unit opens (any doubt refuses: fail closed); one read-write
 * unit replaces the seller's request. Nothing the seller carries changes: an admin applies the
 * choice in review. A repeat of the saved set writes nothing.
 */
export class MyFileActivitiesSave extends UseCase<
  MyActivitiesSaveInput,
  MyActivitiesSaved,
  MyActivitiesSaveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-activities-save',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyActivitiesSaveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyActivitiesSaveInput,
  ): Promise<Result<MyActivitiesSaved, MyActivitiesSaveFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'my-file-activities-save',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? (result.value.changed ? 'saved' : 'unchanged') : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: MyActivitiesSaveInput,
  ): Promise<Result<MyActivitiesSaved, MyActivitiesSaveFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, activityRequests, activityDirectory, clock } = this.deps;

    const reserved = await reserveRateLimits(this.deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const parsed = parseActivityRequest(input.body);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.error });
    const assignment = parsed.value;

    if (!(await fileExists(this.deps, context, owner.sellerId))) {
      return err({ code: 'file.not-found' });
    }

    // Catalog opens a read-only unit of its own, so no unit is open while asking.
    const active = await activityDirectory.activeIds(context, allActivityIds(assignment));
    if (!active.ok) return err({ code: 'sellers.unavailable' });
    const fields: ActivityFieldProblem[] = [];
    if (!active.value.has(assignment.mainActivityId)) {
      fields.push({ path: 'mainActivityId', code: 'not-active' });
    }
    assignment.extraActivityIds.forEach((id, index) => {
      if (!active.value.has(id)) {
        fields.push({ path: `extraActivityIds.${index}`, code: 'not-active' });
      }
    });
    if (fields.length > 0) return err({ code: 'validation.failed', fields });

    try {
      return await unitOfWork.run<MyActivitiesSaved, MyActivitiesSaveFailure>(market, async () => {
        const held = await activityRequests.find(market, owner.sellerId);
        const same =
          held !== null &&
          held.mainActivityId === assignment.mainActivityId &&
          held.extraActivityIds.length === assignment.extraActivityIds.length &&
          held.extraActivityIds.every((id, index) => id === assignment.extraActivityIds[index]);
        if (same) return ok({ ...assignment, changed: false });
        await activityRequests.save(market, owner.sellerId, {
          ...assignment,
          by: owner.accountId,
          at: clock.now(),
        });
        return ok({ ...assignment, changed: true });
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
