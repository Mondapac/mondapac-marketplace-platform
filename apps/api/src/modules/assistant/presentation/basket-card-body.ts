import type { BasketProposal } from '../domain/plan-basket';

/** Every `Money` of the proposal has a bigint `amount`; on the wire it is a string of minor units. */
function wire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(wire);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, wire(inner)]));
  }
  return value;
}

/** The `basket-proposal` card as JSON (money as `{ amount: "<minor units>", currency }`). */
export const basketCardBody = (proposal: BasketProposal) => ({
  kind: 'basket-proposal' as const,
  proposal: wire(proposal),
});
