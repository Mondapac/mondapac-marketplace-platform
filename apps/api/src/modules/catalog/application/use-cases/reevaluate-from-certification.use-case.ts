import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  CertificationCause,
  TagReevaluationRequestRepository,
} from '../ports/tag-reevaluation-requests';

/** One delivery of a consumed certification event (design 5.5), as the subscription maps it. */
export interface ReevaluateFromCertificationInput {
  readonly delivery: EventDelivery;
  readonly cause: CertificationCause;
  /** The id the cause selects by: the seller, the certificate, the submission or the type. */
  readonly subjectId: Id;
}

export type ReevaluateFromCertificationOutput =
  | { readonly code: 'catalog.reevaluation-requested' }
  | { readonly code: 'catalog.reevaluation.already-handled' };

export type ReevaluateFromCertificationFailure = { readonly code: 'access.denied' };

export interface ReevaluateFromCertificationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: TagReevaluationRequestRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The handler `catalog.reevaluate-from-certification` (catalog design 5.5, 9.5; slice 12). Rule
 * `system`, from the subscriptions on certification's seller-certification, claim policy and
 * manufacturer certificate events; the Market
 * is the envelope's (the subscriber context), never a payload field. In one unit opened through
 * the inbox's `runOnce`, it writes one pending `certification-event` request naming the cause,
 * the subject id and the event; the job `catalog.reevaluate-tags` then selects the tags from
 * catalog's own rows (published copies only, 5.1a point 5), marks them `rechecking` first for an
 * expired or revoked certificate, asks `evaluateClaims` and settles each Offer in its own unit.
 * A repeat of the event stops at the inbox, and the request's unique source event backs it, so
 * a second delivery changes nothing (AC 12). Nothing is asked here: the unit stays short and a
 * fault of certification cannot make the delivery fail. Logs hold ids and codes only.
 */
export class ReevaluateFromCertification extends UseCase<
  ReevaluateFromCertificationInput,
  ReevaluateFromCertificationOutput,
  ReevaluateFromCertificationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.reevaluate-from-certification',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReevaluateFromCertification');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReevaluateFromCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReevaluateFromCertificationInput,
  ): Promise<Result<ReevaluateFromCertificationOutput, ReevaluateFromCertificationFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const handled = await deps.unitOfWork.runOnce(market, input.delivery, async () => {
      await deps.requests.requestForEvent(market, {
        id: deps.ids.next<'TagReevaluationRequest'>(),
        cause: input.cause,
        subjectId: input.subjectId,
        sourceEventId: input.delivery.eventId,
        now: deps.clock.now(),
      });
      return ok(undefined);
    });
    if (!handled.ok) throw new Error('reevaluate-from-certification: the unit failed');
    const output: ReevaluateFromCertificationOutput = handled.value.handled
      ? { code: 'catalog.reevaluation-requested' }
      : { code: 'catalog.reevaluation.already-handled' };
    this.#logger.log({
      msg: output.code,
      cause: input.cause,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
