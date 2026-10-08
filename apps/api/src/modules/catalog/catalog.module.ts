import { Module, type FactoryProvider } from '@nestjs/common';
import { registerEvents } from '../../platform/events/event-catalogue';
import { ExtensionPointRegistry } from '../../platform/extensions';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { CATALOG_EVENTS } from './domain/events';
import {
  PRODUCT_TYPE_POINT,
  isProductTypeHandler,
  type ProductTypeHandler,
} from './domain/product-type-handler';
import { configurableProductType } from './domain/product-types/configurable';
import { simpleProductType } from './domain/product-types/simple';
import { catalogProviders } from './infrastructure/catalog-providers';

/**
 * Declares the point `catalog.product-type` and registers the two structural types core owns
 * (catalog design 3.1 rows 1 and 3). A Vertical's own type registers through the same call
 * from its `verticals/<vertical>/` folder. The registry is sealed when the application has
 * bootstrapped.
 */
const productTypeProvider: FactoryProvider<string> = {
  provide: Symbol('catalog.product-types'),
  inject: [ExtensionPointRegistry],
  useFactory: (registry: ExtensionPointRegistry): string => {
    registry.declarePoint<ProductTypeHandler>(PRODUCT_TYPE_POINT, 'catalog', isProductTypeHandler);
    for (const handler of [simpleProductType, configurableProductType]) {
      registry.register(PRODUCT_TYPE_POINT, handler.typeCode, handler, { module: 'catalog' });
    }
    return 'catalog';
  },
};

/**
 * The catalog bounded context (docs/design/domain/catalog.md; ADR-0013), filled slice by slice.
 * Slice 1 binds its outbox writer and events, the product store and the two structural product
 * types; its use cases arrive with slices 6 and 7.
 */
@Module({
  providers: [
    PersistenceModule.outboxWriterFor('catalog'),
    registerEvents('catalog', CATALOG_EVENTS),
    productTypeProvider,
    ...catalogProviders,
  ],
})
export class CatalogModule {}
