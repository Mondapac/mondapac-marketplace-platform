import { routeSearch, type SearchRoute } from '../search-route.ts';

/** A Stripe refund id as the API takes it (`q`): `re_` and letters or digits. */
const STRIPE_REFUND_ID = /^re_[A-Za-z0-9]{1,64}$/;

/**
 * The API input the one search box fills: a UUID or a Stripe refund id (`re_...`) is an exact `q`;
 * any other text of 2 to 80 characters is a customer or store name (`search`). Text that only
 * starts with `re_` but is not an id (a store called "re_cycle shop") is a name, since the API
 * refuses a `q` that is not an id.
 */
export const refundSearchRoute = (text: string): SearchRoute =>
  routeSearch(text, { exact: STRIPE_REFUND_ID.test(text.trim()) });
