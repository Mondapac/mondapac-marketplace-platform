import type { Id } from '@mondapac/shared-kernel';
import { SellerRegistered } from '../../../identity';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { AfterSubmission } from '../../application/use-cases/after-submission.use-case';
import type { ApplySignupCultures } from '../../application/use-cases/apply-signup-cultures.use-case';
import type { CreateSellerFile } from '../../application/use-cases/create-seller-file.use-case';
import { BusinessFileSubmitted } from '../../domain/events';

/** The subscriber name: also the `handler` of `sellers.inbox` (data design 3.12). */
export const CREATE_FILE_SUBSCRIBER = 'sellers.create-file';

/** The subscriber name of the handler that runs after a submission (design 7.5). */
export const AFTER_SUBMISSION_SUBSCRIBER = 'sellers.after-submission';

/** The subscriber name of the handler that attaches a new seller to cultures (ADR-0048). */
export const APPLY_SIGNUP_CULTURES_SUBSCRIBER = 'sellers.apply-signup-cultures';

/**
 * Sellers' subscriptions to `identity.seller-registered.v1` (sellers design 7.5; slice 1). An
 * entry adapter: the dispatcher hands it the decoded event, the delivery and the Market's
 * system-actor context, which go unchanged to one `system` use case. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function sellerFileSubscriptions(
  createFile: CreateSellerFile,
  afterSubmission: AfterSubmission,
  applySignupCultures: ApplySignupCultures,
): RegisteredSubscription[] {
  return [
    subscription({
      name: CREATE_FILE_SUBSCRIBER,
      event: SellerRegistered,
      async handle(event, delivery, context) {
        const result = await createFile.execute(context, {
          delivery,
          sellerId: event.payload.sellerId,
          origin: event.payload.origin,
        });
        if (!result.ok) throw new Error(`${CREATE_FILE_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
    // The default selection of a new seller is "universal" (ADR-0048): the event carries no
    // text, so an explicit list comes through the facade from a step that has one. The file is
    // created by the handler above, possibly after this one: a missing file throws and the
    // delivery is retried.
    subscription({
      name: APPLY_SIGNUP_CULTURES_SUBSCRIBER,
      event: SellerRegistered,
      async handle(event, _delivery, context) {
        const result = await applySignupCultures.execute(context, {
          sellerId: event.payload.sellerId as Id<'Seller'>,
        });
        if (!result.ok) {
          throw new Error(`${APPLY_SIGNUP_CULTURES_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: AFTER_SUBMISSION_SUBSCRIBER,
      event: BusinessFileSubmitted,
      async handle(event, delivery, context) {
        const result = await afterSubmission.execute(context, {
          delivery,
          sellerId: event.payload.sellerId,
          revisionId: event.payload.revisionId,
          kind: event.payload.kind,
        });
        if (!result.ok) {
          throw new Error(`${AFTER_SUBMISSION_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
