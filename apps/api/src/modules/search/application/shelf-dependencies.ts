import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { OfferSearchReader } from './ports/offer-search.reader';
import type { ProductImages } from './ports/product-images';
import type { PublicVisibility } from './ports/public-visibility';
import type { PublishedVariants } from './ports/published-variants';
import type { SearchPolicy } from './ports/search-policy';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';
import type { ShelfSources } from './ports/shelf-sources';

/** The ports of the two shelf reads (storefront reads package). */
export interface ShelfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: OfferSearchReader;
  readonly shelves: ShelfDocumentsReader;
  readonly sources: ShelfSources;
  readonly visibility: PublicVisibility;
  readonly policy: SearchPolicy;
  readonly variants: PublishedVariants;
  readonly images: ProductImages;
}
