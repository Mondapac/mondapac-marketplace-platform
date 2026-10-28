import { SellerBlogAccessChanged } from '../../../sellers';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { PauseSellerBlogPosts } from '../../application/use-cases/pause-seller-posts.use-case';

/** The subscriber name: also the `handler` of `blog.inbox`. */
export const PAUSE_SELLER_POSTS = 'blog.pause-seller-posts';

/**
 * Blog's subscription to sellers' `sellers.blog-access-changed.v1`. An entry adapter only: the
 * delivery and the Market's system-actor context (the Market from the envelope) go unchanged to
 * the one `system` use case. A refusal throws, so the delivery is retried and, after its last
 * attempt, dead-lettered with an alert.
 */
export function sellerBlogAccessSubscriptions(
  pause: PauseSellerBlogPosts,
): RegisteredSubscription[] {
  return [
    subscription({
      name: PAUSE_SELLER_POSTS,
      event: SellerBlogAccessChanged,
      handle: async (event, delivery, context) => {
        const result = await pause.execute(context, {
          delivery,
          sellerId: event.payload.sellerId,
          enabled: event.payload.enabled,
          unpublishLive: event.payload.unpublishLive,
        });
        if (!result.ok) throw new Error(`${PAUSE_SELLER_POSTS} refused: ${result.error.code}`);
      },
    }),
  ];
}
