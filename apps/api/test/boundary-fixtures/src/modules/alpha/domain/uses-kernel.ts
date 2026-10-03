import { isMinted } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';

// Allowed: domain/ may import the shared kernel, by its package name.
export function allowed(market: MarketContext): boolean {
  return isMinted(market);
}
