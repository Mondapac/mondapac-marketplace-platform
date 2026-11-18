import type { Money } from '@mondapac/shared-kernel';
import type {
  AlternativeStore,
  BasketLine,
  BasketOption,
  BasketProposal,
  BasketStore,
  NotFoundLine,
  UncertainLine,
} from '../domain/plan-basket';

// The wire shape of the `basket-proposal` card, written out field by field: a domain field never
// reaches the API by accident, and a rename in the domain is a compile error here (stage 1, F1
// builds against this).

const money = (value: Money) => ({ amount: value.amount.toString(), currency: value.currency });

const optionBody = (option: BasketOption) => ({
  offerId: option.offerId,
  productId: option.productId,
  sellerId: option.sellerId,
  sellerName: option.sellerName,
  name: option.name,
  price: money(option.price),
  priceFrom: option.priceFrom,
  taxInclusive: option.taxInclusive,
  quantity: option.quantity,
  sizeNote: option.sizeNote,
  variantId: option.variantId,
  maxQuantity: option.maxQuantity,
});

const lineBody = (line: BasketLine) => ({
  itemIndex: line.itemIndex,
  text: line.text,
  offerId: line.offerId,
  productId: line.productId,
  sellerId: line.sellerId,
  name: line.name,
  quantity: line.quantity,
  price: money(line.price),
  lineTotal: money(line.lineTotal),
  priceFrom: line.priceFrom,
  taxInclusive: line.taxInclusive,
  sizeNote: line.sizeNote,
  variantId: line.variantId,
  maxQuantity: line.maxQuantity,
  alternatives: line.alternatives.map(optionBody),
});

const storeBody = (store: BasketStore) => ({
  sellerId: store.sellerId,
  sellerName: store.sellerName,
  lines: store.lines.map(lineBody),
  subtotal: money(store.subtotal),
  subtotalIsFrom: store.subtotalIsFrom,
});

const uncertainBody = (line: UncertainLine) => ({
  itemIndex: line.itemIndex,
  text: line.text,
  options: line.options.map(optionBody),
});

const notFoundBody = (line: NotFoundLine) => ({
  itemIndex: line.itemIndex,
  text: line.text,
  reason: line.reason,
});

const alternativeStoreBody = (store: AlternativeStore) => ({
  sellerId: store.sellerId,
  sellerName: store.sellerName,
  covered: store.covered,
  total: money(store.total),
});

/** The `basket-proposal` card as JSON (money as `{ amount: "<minor units>", currency }`). */
export const basketCardBody = (proposal: BasketProposal) => ({
  kind: 'basket-proposal' as const,
  proposal: {
    mode: proposal.mode,
    goal: proposal.goal,
    itemCount: proposal.itemCount,
    stores: proposal.stores.map(storeBody),
    uncertain: proposal.uncertain.map(uncertainBody),
    notFound: proposal.notFound.map(notFoundBody),
    alternativeStores: proposal.alternativeStores.map(alternativeStoreBody),
    total: proposal.total === null ? null : money(proposal.total),
    totalIsFrom: proposal.totalIsFrom,
    deliveryShownAtCheckout: proposal.deliveryShownAtCheckout,
  },
});
