import type { WasPriceCheck } from './ports/was-price-check';
import type { ShelfDependencies } from './shelf-dependencies';

/** The specials shelf's ports: the shelf ports plus the Market's was-price rule. */
export interface SpecialsDependencies extends ShelfDependencies {
  readonly wasPrice: WasPriceCheck;
}
