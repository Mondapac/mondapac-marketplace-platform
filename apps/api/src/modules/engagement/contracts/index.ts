// Public contracts of the engagement module (ADR-0008): the facades, their tokens and the
// permission catalogue. Every customer use case is `own-resources`; the admin's read of one
// customer's behaviour holds `engagement.customer-behaviour.view`. The store follow events are
// exported for their subscribers (customers' per-seller read model). Other modules may import only
// what this file exports, through ../index.ts.
export {
  ENGAGEMENT_FACADE,
  type AccountStoreFollow,
  type EngagementFacade,
  type StoreFollowReadFailure,
  type StoreFollowWriteFailure,
  type RecentViews,
  type RecentViewsRequest,
} from './engagement.facade';
export {
  CUSTOMER_BEHAVIOUR_FACADE,
  TOP_CATEGORIES,
  type AdminCartAddition,
  type AdminCartAdditionsRequest,
  type AdminCustomerBehaviour,
  type CustomerBehaviourFacade,
  type CustomerBehaviourFailure,
} from './customer-behaviour.facade';
export { ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW, ENGAGEMENT_PERMISSIONS } from './permissions';
export { recentViewsRequestOf } from './recent-views-request';
export {
  StoreFollowedEvent as StoreFollowed,
  StoreUnfollowedEvent as StoreUnfollowed,
} from '../domain/store-follow';
