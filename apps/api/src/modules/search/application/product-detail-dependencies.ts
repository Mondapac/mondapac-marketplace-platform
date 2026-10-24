import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { ProductImages } from './ports/product-images';
import type { ProductDetailSources } from './ports/product-detail-sources';
import type { PublicVisibility } from './ports/public-visibility';
import type { PublishedVariants } from './ports/published-variants';
import type { SearchPolicy } from './ports/search-policy';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';

/** The ports of the product page read (storefront reads package). */
export interface ProductDetailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly shelves: ShelfDocumentsReader;
  readonly sources: ProductDetailSources;
  readonly visibility: PublicVisibility;
  readonly policy: SearchPolicy;
  readonly variants: PublishedVariants;
  readonly images: ProductImages;
}
