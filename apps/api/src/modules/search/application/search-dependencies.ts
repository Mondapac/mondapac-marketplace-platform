import type { Clock } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { OfferDocumentRepository } from './ports/offer-document.repository';
import type { OfferFeed } from './ports/offer-feed';
import type { OfferSearchReader } from './ports/offer-search.reader';
import type { PublicVisibility } from './ports/public-visibility';
import type { SearchPolicy } from './ports/search-policy';

/** The ports the search use cases share; each use case reads the ones it needs. */
export interface SearchDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly documents: OfferDocumentRepository;
  readonly reader: OfferSearchReader;
  readonly policy: SearchPolicy;
  readonly feed: OfferFeed;
  readonly visibility: PublicVisibility;
  readonly clock: Clock;
}
