import type { Clock } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { BrandProducts } from './ports/brand-products';
import type { CategorySubtreeSource } from './ports/category-subtree';
import type { OfferDocumentRepository } from './ports/offer-document.repository';
import type { OfferFeed } from './ports/offer-feed';
import type { OfferSearchIndex } from './ports/offer-search-index';
import type { CategoryTreeSource } from './ports/category-tree';
import type { StoreDirectory } from './ports/store-directory';
import type { SearchFilterSource } from './ports/search-filters';
import type { ProductImages } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { SearchPolicy } from './ports/search-policy';
import type { SellerEligibility } from './ports/seller-eligibility';
import type { SellUnitStates } from './ports/sell-unit-states';
import type { OfferVariantReader } from './ports/offer-variant.reader';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';
import type { StoreResolver } from './ports/store-resolver';

/** The ports the search use cases share; each use case reads the ones it needs. */
export interface SearchDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly documents: OfferDocumentRepository;
  /** Ranked search, browse, filter reads and scope counts behind one port (option B). */
  readonly index: OfferSearchIndex;
  /** The filter lists catalog defines (A7). */
  readonly filterSource: SearchFilterSource;
  readonly policy: SearchPolicy;
  readonly feed: OfferFeed;
  readonly visibility: PublicVisibility;
  readonly sellers: SellerEligibility;
  /** The stock and price of sell units, for the variant rows of a document (V8). */
  readonly sellUnits: SellUnitStates;
  /** The sell units of hits, and the exact-GTIN lookup (V8). */
  readonly variants: OfferVariantReader;
  readonly clock: Clock;
  /** A store's list is read from the same documents, by seller (Prisma, no raw SQL). */
  readonly shelves: ShelfDocumentsReader;
  readonly stores: StoreResolver;
  /** A brand's list is read from the same documents, by the brand's product ids (catalog's). */
  readonly brands: BrandProducts;
  readonly images: ProductImages;
  /** A category filter covers the category and its subcategories (catalog's live tree). */
  readonly categories: CategorySubtreeSource;
  /** The live category tree with public names, for "In categories" counts. */
  readonly categoryTree: CategoryTreeSource;
  /** The public stores (address and name) among sellers, for names in the index (search 1a). */
  readonly storeDirectory: StoreDirectory;
}
