import type { Clock } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { OfferDocumentRepository } from './ports/offer-document.repository';
import type { OfferFeed } from './ports/offer-feed';
import type { OfferSearchReader } from './ports/offer-search.reader';
import type { ProductImages } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { SearchPolicy } from './ports/search-policy';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';
import type { StoreResolver } from './ports/store-resolver';

/** The ports the search use cases share; each use case reads the ones it needs. */
export interface SearchDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly documents: OfferDocumentRepository;
  readonly reader: OfferSearchReader;
  readonly policy: SearchPolicy;
  readonly feed: OfferFeed;
  readonly visibility: PublicVisibility;
  readonly clock: Clock;
  /** A store's list is read from the same documents, by seller (Prisma, no raw SQL). */
  readonly shelves: ShelfDocumentsReader;
  readonly stores: StoreResolver;
  readonly images: ProductImages;
}
