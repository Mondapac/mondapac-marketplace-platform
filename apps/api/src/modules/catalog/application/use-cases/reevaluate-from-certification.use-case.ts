import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  TYPE_CAUSES,
  type CertificationCause,
  type TagReevaluationRequestRepository,
} from '../ports/tag-reevaluation-requests';

/** One delivery of a consumed certification event (design 5.5), as the subscription maps it. */
export interface ReevaluateFromCertificationInput {
  readonly delivery: EventDelivery;
  /** When the consumed event occurred (its envelope): an older pending request never covers it. */
  readonly occurredAt: Temporal.Instant;
  readonly cause: CertificationCause;
  /** The id the cause selects by: the seller, the certificate, the submission or the type. */
  readonly subjectId: Id;
  /**
   * A manufacturer certificate whose tags are re-asked too, marked `rechecking` first (Hassan
   * M2): set for a coverage change, whose type request alone could leave a product the new
   * coverage drops badged until its turn.
   */
  readonly recheckCertificateId?: Id;
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
 * the subject id and the event (a coverage change writes a second one, on the certificate, with
 * the cause `product-certification-coverage-recheck`; a type request is skipped when an identical
 * pending one has not started and was written after the event occurred, Hassan M2 and N1); the
 * job `catalog.reevaluate-tags` then selects the tags from catalog's own rows (published copies only, 5.1a point 5), marks them `rechecking` first for an
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
    let skipped = false;
    const handled = await deps.unitOfWork.runOnce(market, input.delivery, async () => {
      const now = deps.clock.now();
      if (input.recheckCertificateId !== undefined) {
        await deps.requests.requestForEvent(market, {
          id: deps.ids.next<'TagReevaluationRequest'>(),
          cause: 'product-certification-coverage-recheck',
          subjectId: input.recheckCertificateId,
          sourceEventId: input.delivery.eventId,
          now,
        });
      }
      // A type request re-asks every live tag of the type when it runs: an identical one no run
      // has started, written after this event occurred, already covers it (Hassan M2, N1).
      skipped =
        (TYPE_CAUSES as readonly string[]).includes(input.cause) &&
        (await deps.requests.pendingUnstarted(market, {
          cause: input.cause,
          subjectId: input.subjectId,
          createdAfter: input.occurredAt,
        }));
      if (!skipped) {
        await deps.requests.requestForEvent(market, {
          id: deps.ids.next<'TagReevaluationRequest'>(),
          cause: input.cause,
          subjectId: input.subjectId,
          sourceEventId: input.delivery.eventId,
          now,
        });
      }
      return ok(undefined);
    });
    if (!handled.ok) throw new Error('reevaluate-from-certification: the unit failed');
    const output: ReevaluateFromCertificationOutput = handled.value.handled
      ? { code: 'catalog.reevaluation-requested' }
      : { code: 'catalog.reevaluation.already-handled' };
    this.#logger.log({
      msg: output.code,
      cause: input.cause,
      ...(handled.value.handled ? { typeRequestSkipped: skipped } : {}),
      recheck: input.recheckCertificateId !== undefined,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
