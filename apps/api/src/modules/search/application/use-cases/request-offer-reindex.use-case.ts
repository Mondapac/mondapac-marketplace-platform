import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ReindexProgress } from '../ports/reindex';

/** Why a full re-read was asked for (logged; never user text). */
export const REINDEX_REQUEST_REASONS = [
  'culture-status',
  'issuer-derecognised',
  'type-deactivated',
  'scope-too-large',
] as const;
export type ReindexRequestReason = (typeof REINDEX_REQUEST_REASONS)[number];

export interface RequestOfferReindexInput {
  readonly reason: ReindexRequestReason;
}

export interface RequestOfferReindexDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly progress: ReindexProgress;
  readonly clock: Clock;
}

/**
 * `search.request-offer-reindex` (multi-culture package 3a): asks the resumable Market reindex
 * (`search.reindex-attributes`, every five minutes) to re-read every published Offer at its next
 * tick, for a change that touches too many Offers for one delivery or that catalog's stamp cannot
 * see (a culture's status, a certificate issuer derecognised, a certification type deactivated, a
 * category subtree above the direct-sync threshold). One write in one unit; it never reads the
 * Offers itself, so it never fails on size. Rule `system`. A failed write throws, so the delivery is
 * retried.
 */
export class RequestOfferReindex extends UseCase<
  RequestOfferReindexInput,
  { readonly requested: true },
  { readonly code: 'validation.failed' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.request-offer-reindex',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RequestOfferReindex');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RequestOfferReindexDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RequestOfferReindexInput,
  ): Promise<Result<{ readonly requested: true }, { readonly code: 'validation.failed' }>> {
    const reason: unknown = typeof input === 'object' && input !== null ? input.reason : undefined;
    if (!(REINDEX_REQUEST_REASONS as readonly unknown[]).includes(reason)) {
      return err({ code: 'validation.failed' });
    }
    const { market } = context;
    const done = await this.deps.unitOfWork.run(market, async () => {
      await this.deps.progress.request(market, this.deps.clock.now());
      return ok(undefined);
    });
    if (!done.ok) throw new Error('search: the reindex request failed');
    this.#logger.log({
      msg: 'search.reindex-requested',
      reason,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ requested: true });
  }
}
