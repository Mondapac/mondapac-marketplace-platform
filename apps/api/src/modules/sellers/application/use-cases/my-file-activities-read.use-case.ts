import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import type { StoredActivityAssignment } from '../../domain/seller-business-activities';
import {
  logDraftOutcome,
  sellerActorOf,
  type DraftAccessDenied,
  type SellersUnavailable,
} from '../draft/draft-support';
import type { FileNotFound } from '../draft/draft-view';
import type { SellerActivityRequestRepository } from '../ports/seller-activity-request.repository';
import type { SellerBusinessActivityRepository } from '../ports/seller-business-activity.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

// The seller's own choice of business activities during setup (BUG-012 step 2; ADR-0040 decision
// 4: chosen at sign-up, approved in review). The choice is a REQUEST kept in its own table: it never
// changes what the seller carries. The reviewer reads it on the seller page and applies it, or
// another set, with the admin change (which has a reason and a step-up).

/** The seller's request and what the seller carries now, as ids. */
export interface MyActivitiesView {
  /** What the seller asked for; null until the first save. */
  readonly requested: {
    readonly mainActivityId: string;
    readonly extraActivityIds: readonly string[];
    readonly requestedAt: string;
  } | null;
  /** What an admin has assigned; null main until the reviewer confirms one. */
  readonly assigned: {
    readonly mainActivityId: string | null;
    readonly extraActivityIds: readonly string[];
  };
}

export type MyActivitiesReadFailure = DraftAccessDenied | FileNotFound | SellersUnavailable;

export interface MyActivitiesReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly activityRequests: SellerActivityRequestRepository;
  readonly businessActivities: SellerBusinessActivityRepository;
}

/**
 * `my-file.activities-read`: the seller's own request and the activities an admin assigned. Rule
 * `permissions [sellers.business-identity.edit]`, allowed while the seller is not approved. The
 * seller is always `ActorContext.sellerId`. One read-only unit.
 */
export class MyFileActivitiesRead extends UseCase<
  Record<string, never>,
  MyActivitiesView,
  MyActivitiesReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-activities-read',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyActivitiesReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<MyActivitiesView, MyActivitiesReadFailure>> {
    const result = await this.read(context);
    logDraftOutcome(
      'my-file-activities-read',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'read' : result.error.code,
    );
    return result;
  }

  private async read(
    context: CallContext,
  ): Promise<Result<MyActivitiesView, MyActivitiesReadFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<MyActivitiesView, MyActivitiesReadFailure>(
        market,
        async () => {
          if ((await this.deps.files.findById(market, owner.sellerId)) === null) {
            return err({ code: 'file.not-found' });
          }
          const request = await this.deps.activityRequests.find(market, owner.sellerId);
          const held: StoredActivityAssignment = (
            await this.deps.businessActivities.find(market, [owner.sellerId])
          ).get(owner.sellerId) ?? { mainActivityId: null, extraActivityIds: [] };
          return ok({
            requested:
              request === null
                ? null
                : {
                    mainActivityId: request.mainActivityId,
                    extraActivityIds: request.extraActivityIds,
                    requestedAt: request.requestedAt.toString(),
                  },
            assigned: {
              mainActivityId: held.mainActivityId,
              extraActivityIds: held.extraActivityIds,
            },
          });
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
