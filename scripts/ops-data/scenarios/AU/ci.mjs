// The small "ci" profile of the AU scenario (operational test data design, phase 3): the same
// scenario cut down to what a pull request's CI run can build in a couple of minutes, so a change
// to the API that breaks the loader turns that pull request red. The packs still call the real API
// the way the panels do; only the amount of data is smaller.
//
// Kept: the whole catalog structure (categories, attributes, feature sets, cultures), the admin
// and the reviewer, one certified halal butcher and one bakery with three offers each, and one
// seller in every other onboarding state (in review, rejected, suspended, draft).
// Left out: the content pack (slides, home page, blog) and the orders pack, which needs a Stripe
// test key and runs only in the Stripe test workflow (.github/workflows/stripe-test.yml).

/** The sellers with offers in the profile, and how many of their offers are kept. */
const LISTING_SELLERS = ['kedron', 'paddington'];
const OFFERS_KEPT = 3;

/** The sellers in an onboarding state other than approved, kept for the admin queues. */
const keptSeller = (seller) => LISTING_SELLERS.includes(seller.key) || seller.state !== 'approved';

export function ciProfile(scenario) {
  const sellers = scenario.sellers.filter(keptSeller);
  const offers = Object.fromEntries(
    LISTING_SELLERS.map((key) => [key, scenario.offers[key].slice(0, OFFERS_KEPT)]),
  );
  const productKeys = new Set(Object.values(offers).flatMap((list) => list.map((o) => o.product)));
  const products = scenario.products.filter((product) => productKeys.has(product.key));
  const first = offers.kedron[0];
  return {
    ...scenario,
    sellers,
    offers,
    products,
    // One price rise held for the admin, on a product the profile keeps.
    held: { seller: 'kedron', product: first.product, amount: 9990 },
    // Nothing for the packs the profile does not run.
    content: null,
    buyers: [],
    orders: [],
    openCarts: [],
  };
}

/** The packs the profile runs, in order. */
export const CI_PACKS = ['admin', 'catalog', 'sellers', 'products'];
