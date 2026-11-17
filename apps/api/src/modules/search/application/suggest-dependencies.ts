import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CategoryTreeSource } from './ports/category-tree';
import type { OfferSearchIndex } from './ports/offer-search-index';
import type { ProductImages } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { SearchPolicy } from './ports/search-policy';
import type { StoreDirectory } from './ports/store-directory';
import type { StoreDocumentRepository } from './ports/store-document.repository';
import type { SuggestCache } from './ports/suggest-cache';

/** The ports of the suggest read (search 1b): the same ones search and store search use, plus a cache. */
export interface SuggestDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly index: OfferSearchIndex;
  readonly policy: SearchPolicy;
  /** The query-time re-check of the Offers (catalog published and listed, seller may sell). */
  readonly visibility: PublicVisibility;
  readonly images: ProductImages;
  readonly categoryTree: CategoryTreeSource;
  readonly storeDirectory: StoreDirectory;
  readonly storeDocuments: StoreDocumentRepository;
  readonly cache: SuggestCache;
}
