// The `/contexts` entry of the miniature kernel: the actor and call-context constructors,
// which only platform/ may import (contexts-are-built-by-platform).
export function systemActor(market: { readonly marketId: string }): object {
  return { kind: 'system', marketId: market.marketId };
}
