import type { PersonalSignals } from './ports/personal-signals';
import type { ShelfDependencies } from './shelf-dependencies';

/** The ports of the personal reads: the shelf ports and the shopper's signals. */
export interface RecommendationDependencies extends ShelfDependencies {
  readonly signals: PersonalSignals;
}
