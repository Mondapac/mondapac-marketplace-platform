import type { Clock } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { BrandProducts } from './ports/brand-products';
import type { CategorySubtreeSource } from './ports/category-subtree';
import type { OfferDocumentRepository } from './ports/offer-document.repository';
import type { OfferFeed } from './ports/offer-feed';
import type { OfferSearchReader } from './ports/offer-search.reader';
import type { ProductImages } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { SearchPolicy } from './ports/search-policy';
import type { SellerEligibility } from './ports/seller-eligibility';
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
  readonly sellers: SellerEligibility;
  readonly clock: Clock;
  /** A store's list is read from the same documents, by seller (Prisma, no raw SQL). */
  readonly shelves: ShelfDocumentsReader;
  readonly stores: StoreResolver;
  /** A brand's list is read from the same documents, by the brand's product ids (catalog's). */
  readonly brands: BrandProducts;
  readonly images: ProductImages;
  /** A category filter covers the category and its subcategories (catalog's live tree). */
  readonly categories: CategorySubtreeSource;
}
