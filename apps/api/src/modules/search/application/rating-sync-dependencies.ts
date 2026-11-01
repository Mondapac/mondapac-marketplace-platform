import type { Clock } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { ProductRatingRepository, ProductRatingSource } from './ports/product-rating';
import type { SearchPolicy } from './ports/search-policy';

/** What the rating sync needs. */
export interface RatingSyncDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ratings: ProductRatingRepository;
  readonly source: ProductRatingSource;
  readonly policy: SearchPolicy;
  readonly clock: Clock;
}
