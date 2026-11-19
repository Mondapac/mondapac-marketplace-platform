import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_HEALTH_RECALCULATE } from '../../contracts/permissions';
import type { SellerHealthRequestStore } from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';

export interface RequestSellerHealthRecalculationInput {
  readonly sellerId: string;
}

export interface RequestSellerHealthRecalculationOutput {
  /** `queued`: this call wrote the request. `already-queued`: one was waiting; nothing was added. */
  readonly status: 'queued' | 'already-queued';
}

export type RequestSellerHealthRecalculationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface RequestSellerHealthRecalculationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly healthRoster: SellerHealthRoster;
  readonly healthRequests: SellerHealthRequestStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * `sellers.request-seller-health-recalculation` (seller health; "Recalculate now" of the admin):
 * queues a recount of one seller. It does not measure anything itself: the three feeds accept only
 * the system actor, so `sellers.run-seller-health-requests`, a frequent job, reads the request and
 * measures. Rule `permissions [sellers.seller-health.recalculate]`, for an admin session. The
 * seller must belong to the context's Market and have an approved business file (`file.not-found`
 * otherwise, the same answer as for an id that never existed). A second click while a request
 * waits adds nothing. Health only writes numbers: nothing happens to the seller (R2).
 */
export class RequestSellerHealthRecalculation extends UseCase<
  RequestSellerHealthRecalculationInput,
  RequestSellerHealthRecalculationOutput,
  RequestSellerHealthRecalculationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.request-seller-health-recalculation',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_HEALTH_RECALCULATE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RequestSellerHealthRecalculationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RequestSellerHealthRecalculationInput,
  ): Promise<
    Result<RequestSellerHealthRecalculationOutput, RequestSellerHealthRecalculationFailure>
  > {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'file.not-found' });
    const sellerId = parsed.value;
    const { unitOfWork, healthRoster, healthRequests, ids, clock } = this.deps;
    try {
      return await unitOfWork.run<
        RequestSellerHealthRecalculationOutput,
        RequestSellerHealthRecalculationFailure
      >(market, async () => {
        if ((await healthRoster.one(market, sellerId)) === null) {
          return err({ code: 'file.not-found' });
        }
        const written = await healthRequests.enqueue(market, {
          id: ids.next(),
          sellerId,
          source: 'admin',
          byAccountId: actor.accountId,
          at: clock.now(),
        });
        return ok({ status: written.queued ? 'queued' : 'already-queued' });
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
