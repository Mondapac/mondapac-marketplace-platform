import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogWorkQueueFacade } from '../../../catalog';
import type { SettingsFacade } from '../../../settings';
import { ADMIN_NOTICES_PER_MARKET, ADMIN_OFFER_QUEUE_BACKLOG } from '../../domain/in-app-notice';
import { assessBacklog } from '../../domain/offer-queue-backlog';
import type { InAppNoticeRepository } from '../ports/in-app-notice.repository';
import type { NotificationsPolicy } from '../ports/notifications-policy';
import type { OfferQueueBacklogRepository } from '../ports/offer-queue-backlog.repository';

export interface OfferQueueBacklogDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notices: InAppNoticeRepository;
  readonly backlog: OfferQueueBacklogRepository;
  readonly catalogQueue: CatalogWorkQueueFacade;
  readonly settings: SettingsFacade;
  readonly policy: NotificationsPolicy;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export type RaiseOfferQueueBacklogAlertOutput =
  | { readonly code: 'backlog.alerted'; readonly notices: number }
  /** A limit is passed, and the alert of this crossing was raised before (or by an overlapping run). */
  | { readonly code: 'backlog.already-alerted' }
  /** The queue is within both limits; `rearmed` is true when an open alert was closed. */
  | { readonly code: 'backlog.within-limits'; readonly rearmed: boolean };

export type RaiseOfferQueueBacklogAlertFailure =
  { readonly code: 'access.denied' } | { readonly code: 'backlog.unavailable' };

/**
 * The Offer review queue backlog alert (risk-based Offer approval, slice 8; design section 9 c).
 * Rule `system`, run by the worker job for each hosted Market. It reads the queue through catalog
 * (count and the submission time of the oldest Offer) and the two limits through settings, each
 * before the unit (a facade call never runs inside one). The limits are strict: more than the set
 * number of Offers waiting, or the oldest waiting more than the set business hours (Monday to
 * Friday in the Market's zone). Past a limit it raises one admin notice for the crossing and no
 * more: the alert row opens once (a partial unique index makes overlapping runs raise it once),
 * and stays open until the queue is back within both limits, which re-arms it. The notice holds
 * the reason, the queue size and the wait in whole hours only, and is shown to the admins who hold
 * `catalog.product.approve`, who work the queue. A queue that cannot be read raises nothing.
 */
export class RaiseOfferQueueBacklogAlert extends UseCase<
  Record<string, never>,
  RaiseOfferQueueBacklogAlertOutput,
  RaiseOfferQueueBacklogAlertFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.raise-offer-queue-backlog-alert',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RaiseOfferQueueBacklogAlert');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferQueueBacklogDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<RaiseOfferQueueBacklogAlertOutput, RaiseOfferQueueBacklogAlertFailure>> {
    const { deps } = this;
    const now = deps.clock.now();
    const queue = await deps.catalogQueue.offerReviewQueue(context, { now });
    if (!queue.ok) {
      if (queue.error.code === 'access.denied') return err({ code: 'access.denied' });
      return err({ code: 'backlog.unavailable' });
    }
    const limits = await deps.settings.offerQueueBacklogLimits(context);
    // Without the Market's own limits nothing is raised or cleared (no guess, no duplicate alert).
    if (limits === null) return err({ code: 'backlog.unavailable' });
    const assessment = assessBacklog(
      queue.value,
      limits,
      now,
      deps.policy.marketTimezone(context.market),
    );
    const { market } = context;

    const written = await deps.unitOfWork.run<RaiseOfferQueueBacklogAlertOutput, never>(
      market,
      async () => {
        if (assessment.reason === null) {
          return ok({
            code: 'backlog.within-limits' as const,
            rearmed: await deps.backlog.clear(market, now),
          });
        }
        const raised = await deps.backlog.raise(
          market,
          deps.ids.next<'OfferQueueBacklogAlert'>(),
          now,
          assessment.reason,
          queue.value.count,
        );
        if (!raised) return ok({ code: 'backlog.already-alerted' as const });
        await deps.notices.add(market, [
          {
            id: deps.ids.next<'InAppNotice'>(),
            owner: { audience: 'admin' },
            kind: ADMIN_OFFER_QUEUE_BACKLOG,
            params: {
              reason: assessment.reason,
              count: queue.value.count,
              hours: assessment.waitedHours,
            },
            createdAt: now,
          },
        ]);
        await deps.notices.trim(
          market,
          { audience: 'admin' },
          ADMIN_NOTICES_PER_MARKET,
          ADMIN_OFFER_QUEUE_BACKLOG,
        );
        return ok({ code: 'backlog.alerted' as const, notices: 1 });
      },
    );
    if (!written.ok) return err({ code: 'backlog.unavailable' });
    // Counts and codes only.
    this.#logger.log({
      msg: `notifications.${written.value.code}`,
      reason: assessment.reason,
      queue: queue.value.count,
      waitedHours: assessment.waitedHours,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(written.value);
  }
}
