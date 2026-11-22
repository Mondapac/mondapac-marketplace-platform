import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  recordFromEvent,
  type RecordCounts,
  type RecordRequest,
  type ReportFactsDependencies,
  type ReportFactsFailure,
} from '../report-facts-sync';

export interface RecordReportFactsInput extends RecordRequest {
  readonly delivery: EventDelivery;
}

/**
 * `reporting.record-report-facts`: the handler of ordering's order and refund events (dashboards upgrade
 * phase 3). Rule `system`. Reads the seller orders and refunds the event names from their owners
 * and records them with the rollups of every seller day they touch, once per delivery.
 */
export class RecordReportFacts extends UseCase<
  RecordReportFactsInput,
  RecordCounts & { readonly handled: boolean },
  ReportFactsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.record-report-facts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReportFactsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RecordReportFactsInput,
  ): Promise<Result<RecordCounts & { readonly handled: boolean }, ReportFactsFailure>> {
    return recordFromEvent(this.deps, context, input.delivery, {
      sellerOrders: input.sellerOrders,
      refundIds: input.refundIds,
    });
  }
}
