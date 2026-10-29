import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  receiveUberWebhook,
  type FleetWebhookOutcome,
  type ReceiveUberWebhookFailure,
  type ReceiveUberWebhookInput,
} from '../fleet-webhook-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.receive-uber-webhook`: Uber Direct's delivery status webhook. Rule `anonymous`: the
 * caller is Uber, proven by the HMAC signature the use case checks first (the same model as the
 * Drive and Stripe webhooks). It stores what the event changes and nothing else.
 */
export class ReceiveUberWebhook extends UseCase<
  ReceiveUberWebhookInput,
  FleetWebhookOutcome,
  ReceiveUberWebhookFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.receive-uber-webhook',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ReceiveUberWebhookInput) {
    return receiveUberWebhook(this.deps, context, input);
  }
}
