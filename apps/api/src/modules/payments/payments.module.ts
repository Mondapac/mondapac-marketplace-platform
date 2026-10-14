import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { ORDERING_FACADE, OrderingModule } from '../ordering';
import type { PaymentsDependencies } from './application/payments-dependencies';
import { STRIPE_EVENT_INBOX } from './application/ports/stripe-event-inbox';
import { STRIPE_SESSION_READER } from './application/ports/stripe-session-reader';
import { STRIPE_SIGNATURE } from './application/ports/stripe-signature';
import { ApplyStripeEvents } from './application/use-cases/apply-stripe-events.use-case';
import { ReceiveStripeEvent } from './application/use-cases/receive-stripe-event.use-case';
import { paymentsProviders } from './infrastructure/payments-providers';
import { applyStripeEventsJob } from './presentation/jobs/apply-stripe-events.job';
import { StripeWebhookController } from './presentation/stripe-webhook.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: PaymentsDependencies) => U;

const PORTS: readonly [keyof PaymentsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['inbox', STRIPE_EVENT_INBOX],
  ['signature', STRIPE_SIGNATURE],
  ['reader', STRIPE_SESSION_READER],
  ['ordering', ORDERING_FACADE],
  ['clock', CLOCK],
];

/** Every payments use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as PaymentsDependencies,
      ),
  };
}

/**
 * Payments (Phase 5 package 2, speed mode): the Stripe webhook receiver. The endpoint verifies
 * and stores each Checkout event once; the worker job re-reads the session from Stripe and
 * applies it through `ORDERING_FACADE` as the system actor. Test mode only.
 */
@Module({
  imports: [OrderingModule],
  controllers: [StripeWebhookController],
  providers: [
    ...paymentsProviders,
    useCaseProvider(ReceiveStripeEvent),
    useCaseProvider(ApplyStripeEvents),
    registerJobsFrom('payments', [ApplyStripeEvents], (apply: ApplyStripeEvents) => [
      applyStripeEventsJob(apply),
    ]),
  ],
})
export class PaymentsModule {}
