import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { sellerActorOf } from '../draft/draft-support';
import type { SellerHealthRequestStore } from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';

/** How long a seller waits between two "Refresh now" clicks (owner decision, 6 Nov 2026). */
export const SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS = 15 * 60;

export interface RefreshOwnSellerHealthOutput {
  /** `queued`: this call wrote the request. `already-queued`: one was waiting; nothing was added. */
  readonly status: 'queued' | 'already-queued';
}

export type RefreshOwnSellerHealthFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'sellers.unavailable' };

export interface RefreshOwnSellerHealthDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly healthRoster: SellerHealthRoster;
  readonly healthRequests: SellerHealthRequestStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * `sellers.refresh-own-seller-health` (seller health, HLT-03; "Refresh now" of the seller): queues
 * a recount of the acting seller's health, like the admin's "Recalculate now", through the same
 * request table with source `seller`. Rule `own-resources`, approved sellers only; the seller is the
 * actor's and no route takes a seller id. After a click the seller waits
 * {@link SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS} before the next one (`request.throttled` with the
 * seconds left); only the seller's own clicks count, an admin's request never locks the seller. A
 * request still waiting answers `already-queued` and adds nothing. Health only writes numbers:
 * nothing happens to the seller (R2).
 */
export class RefreshOwnSellerHealth extends UseCase<
  Record<string, never>,
  RefreshOwnSellerHealthOutput,
  RefreshOwnSellerHealthFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.refresh-own-seller-health',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RefreshOwnSellerHealthDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<RefreshOwnSellerHealthOutput, RefreshOwnSellerHealthFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, healthRoster, healthRequests, ids, clock } = this.deps;
    try {
      return await unitOfWork.run<RefreshOwnSellerHealthOutput, RefreshOwnSellerHealthFailure>(
        market,
        async () => {
          if ((await healthRoster.one(market, owner.sellerId)) === null) {
            return err({ code: 'file.not-found' });
          }
          const now = clock.now();
          const last = await healthRequests.latest(market, owner.sellerId, 'seller');
          if (last !== null) {
            const elapsedSeconds = Math.floor(
              (now.epochMilliseconds - last.requestedAt.epochMilliseconds) / 1000,
            );
            if (elapsedSeconds < SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS) {
              return err({
                code: 'request.throttled',
                retryAfterSeconds:
                  SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS - Math.max(0, elapsedSeconds),
              });
            }
          }
          const written = await healthRequests.enqueue(market, {
            id: ids.next(),
            sellerId: owner.sellerId,
            source: 'seller',
            byAccountId: owner.accountId,
            at: now,
          });
          return ok({ status: written.queued ? 'queued' : 'already-queued' });
        },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
