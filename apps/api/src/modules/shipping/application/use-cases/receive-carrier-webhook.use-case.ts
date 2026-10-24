import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  receiveCarrierWebhook,
  type ReceiveWebhookFailure,
  type ReceiveWebhookInput,
  type ReceiveWebhookOutcome,
} from '../carrier-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.receive-carrier-webhook`: a real-time carrier's status webhook. Rule `anonymous`:
 * the caller is the carrier, proven by the HMAC signature the use case checks first (the same
 * model as the Stripe webhook). It stores what the event changes and nothing else.
 */
export class ReceiveCarrierWebhook extends UseCase<
  ReceiveWebhookInput,
  ReceiveWebhookOutcome,
  ReceiveWebhookFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.receive-carrier-webhook',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ReceiveWebhookInput) {
    return receiveCarrierWebhook(this.deps, context, input);
  }
}
