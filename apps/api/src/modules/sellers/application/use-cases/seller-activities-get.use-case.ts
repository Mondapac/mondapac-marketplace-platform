import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_BUSINESS_ACTIVITY_VIEW } from '../../contracts/permissions';
import type { SellerBusinessActivityRepository } from '../ports/seller-business-activity.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

export interface SellerActivitiesGetInput {
  readonly sellerId?: unknown;
}

export interface SellerActivitiesView {
  /** Null until an admin assigns one. */
  readonly mainActivityId: string | null;
  readonly extraActivityIds: readonly string[];
  /** The latest change: who, when and why; null when none was ever made. */
  readonly lastChange: {
    readonly changedBy: string;
    readonly changedAt: string;
    readonly reason: string;
  } | null;
}

export type SellerActivitiesGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface SellerActivitiesGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly businessActivities: SellerBusinessActivityRepository;
}

/**
 * `sellers.seller-activities-get` (ADR-0040 decision 4; package 4a): the business activities a
 * seller carries, for the admin page. Rule `permissions [sellers.business-activity.view]`, admin
 * population only. An unknown seller and another Market's seller are both `file.not-found`. Ids,
 * an instant and the admin's reason only. One read-only unit.
 */
export class SellerActivitiesGetUseCase extends UseCase<
  SellerActivitiesGetInput,
  SellerActivitiesView,
  SellerActivitiesGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-activities-get',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_ACTIVITY_VIEW.key] },
  };

  readonly #logger = new Logger('SellerActivitiesGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerActivitiesGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerActivitiesGetInput,
  ): Promise<Result<SellerActivitiesView, SellerActivitiesGetFailure>> {
    const result = await this.get(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.seller-activities-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async get(
    context: CallContext,
    input: SellerActivitiesGetInput,
  ): Promise<Result<SellerActivitiesView, SellerActivitiesGetFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;
    try {
      return await this.deps.unitOfWork.run<SellerActivitiesView, SellerActivitiesGetFailure>(
        market,
        async () => {
          const exists = await this.deps.files.existingIds(market, [sellerId]);
          if (!exists.has(sellerId)) return err({ code: 'file.not-found' });
          const held = (await this.deps.businessActivities.find(market, [sellerId])).get(sellerId);
          const last = await this.deps.businessActivities.lastChange(market, sellerId);
          return ok({
            mainActivityId: held?.mainActivityId ?? null,
            extraActivityIds: held?.extraActivityIds ?? [],
            lastChange:
              last === null
                ? null
                : {
                    changedBy: last.changedBy,
                    changedAt: last.changedAt.toString(),
                    reason: last.reason,
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
