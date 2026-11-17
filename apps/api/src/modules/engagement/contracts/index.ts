// Public contracts of the engagement module (ADR-0008): the facade interface and its token. No
// permission keys: every customer use case is `own-resources`. The store follow events are
// exported for their subscribers (customers' per-seller read model). Other modules may import only what
// this file exports, through ../index.ts.
export {
  ENGAGEMENT_FACADE,
  type AccountStoreFollow,
  type EngagementFacade,
  type StoreFollowReadFailure,
  type StoreFollowWriteFailure,
  type RecentViews,
  type RecentViewsRequest,
} from './engagement.facade';
export { recentViewsRequestOf } from './recent-views-request';
export {
  StoreFollowedEvent as StoreFollowed,
  StoreUnfollowedEvent as StoreUnfollowed,
} from '../domain/store-follow';
