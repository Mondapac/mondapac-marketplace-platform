import { SellerRegistered } from '../../../identity';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { CreateSellerFile } from '../../application/use-cases/create-seller-file.use-case';

/** The subscriber name: also the `handler` of `sellers.inbox` (data design 3.12). */
export const CREATE_FILE_SUBSCRIBER = 'sellers.create-file';

/**
 * Sellers' subscription to `identity.seller-registered.v1` (sellers design 7.5; slice 1). An
 * entry adapter: the dispatcher hands it the decoded event, the delivery and the Market's
 * system-actor context, which go unchanged to one `system` use case. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function sellerFileSubscriptions(createFile: CreateSellerFile): RegisteredSubscription[] {
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
  ];
}
