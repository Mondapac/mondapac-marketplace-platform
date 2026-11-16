import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  IdGenerator,
  Id,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CustomerEventKindInput } from '../../domain/customer-timeline';
import {
  accountOfOrder,
  accountOfRefund,
  type ReadModelFailure,
} from '../customer-read-model-flow';
import type { ReadModelPeers } from '../ports/customer-read-model-peers';
import type { CustomerTimelineRepository } from '../ports/customer-timeline.repository';

export interface TimelineRecordDependencies extends ReadModelPeers {
  readonly unitOfWork: UnitOfWork;
  readonly timeline: CustomerTimelineRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** One consumed event, as the subscription hands it over: ids, codes and the instant only. */
export type RecordTimelineInput = {
  readonly delivery: EventDelivery;
  readonly eventId: string;
  readonly occurredAt: Temporal.Instant;
} & CustomerEventKindInput;

/**
 * `customers.record-customer-timeline`: from a subscription on an `identity` account event or an
 * `ordering` order or refund event. Rule `system`. Copies the event onto the customer's timeline
 * (kind, instant, the order or refund id), once per delivery and once per event (the source event
 * id is unique per customer). The customer is the event's account, or the order's paying account
 * read through `ordering`. An event about an account the module does not know yet (the directory
 * row comes from another subscription) is refused while identity knows it, so the delivery is
 * retried after that row is written; an erased or unknown account gets nothing.
 */
export class RecordCustomerTimeline extends UseCase<
  RecordTimelineInput,
  { readonly recorded: boolean },
  ReadModelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.record-customer-timeline',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TimelineRecordDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecordTimelineInput,
  ): Promise<Result<{ readonly recorded: boolean }, ReadModelFailure>> {
    const { deps } = this;
    const eventId = parseId<'event'>(input.eventId);
    if (eventId === null || !eventId.ok) return err({ code: 'validation.failed' });
    let accountId: Id<'Account'> | null;
    let ref: { readonly type: 'order' | 'refund'; readonly id: string } | null = null;
    if (input.kind === 'order-paid') {
      const found = await accountOfOrder(deps, context, input.orderId);
      if (!found.ok) return found;
      accountId = found.value;
      ref = { type: 'order', id: input.orderId };
    } else if (input.kind === 'refund-succeeded') {
      const found = await accountOfRefund(deps, context, input.orderId, input.refundId);
      if (!found.ok) return found;
      accountId = found.value;
      ref = { type: 'refund', id: input.refundId };
    } else {
      const parsed = parseId<'Account'>(input.accountId);
      if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
      accountId = parsed.value;
    }

    // The directory row may not be there yet (sign-up): ask identity, outside the unit. An account
    // identity knows is refused for now, so the delivery is retried once the read model's own
    // subscription wrote the row (the entry needs it: a foreign key, removed with the erasure).
    if (accountId !== null) {
      const id = accountId;
      const inDirectory = await deps.unitOfWork.run(
        context.market,
        async () => ok(await deps.timeline.hasCustomer(context.market, id)),
        { readOnly: true },
      );
      if (!inDirectory.ok) return err({ code: 'customers.unavailable' });
      if (!inDirectory.value) {
        const records = await deps.identity.customerDirectoryRecords(context, [id]);
        if (!records.ok) return err({ code: 'customers.unavailable' });
        if (!records.value.some((record) => record.accountId === id)) accountId = null;
        else return err({ code: 'customers.unavailable' });
      }
    }

    const target = accountId;
    const handled = await deps.unitOfWork.runOnce<{ readonly recorded: boolean }, ReadModelFailure>(
      context.market,
      input.delivery,
      async () => {
        if (target === null) return ok({ recorded: false });
        const now = deps.clock.now();
        const recorded = await deps.timeline.record(
          context.market,
          {
            id: deps.ids.next<'CustomerTimelineEntry'>(),
            accountId: target,
            occurredAt: input.occurredAt,
            kind: input.kind,
            ref,
            actorAccountId: null,
            detail: null,
            sourceEventId: eventId.value,
          },
          now,
        );
        return ok({ recorded });
      },
    );
    if (!handled.ok) return handled;
    return ok(handled.value.handled ? handled.value.value : { recorded: false });
  }
}
