import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { ExtensionPointRegistry } from '../../platform/extensions';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { ATTRIBUTE_REPOSITORY } from './application/ports/attribute.repository';
import { ATTRIBUTE_SEED } from './application/ports/attribute-seed';
import { CATEGORY_SEED } from './application/ports/category-seed';
import { PLATFORM_CATEGORY_REPOSITORY } from './application/ports/platform-category.repository';
import { SeedAttributes } from './application/use-cases/seed-attributes.use-case';
import { SeedCategoryTree } from './application/use-cases/seed-category-tree.use-case';
import { CATALOG_EVENTS } from './domain/events';
import {
  PRODUCT_TYPE_POINT,
  isProductTypeHandler,
  type ProductTypeHandler,
} from './domain/product-type-handler';
import { configurableProductType } from './domain/product-types/configurable';
import { simpleProductType } from './domain/product-types/simple';
import { catalogProviders } from './infrastructure/catalog-providers';
import { seedAttributesJob } from './presentation/jobs/seed-attributes.job';
import { seedCategoryTreeJob } from './presentation/jobs/seed-category-tree.job';

/**
 * The Nest token of each dependency name the use cases of catalog share: a use case's dependency
 * object is built from these by {@link useCaseProvider}, so a name always means the same port.
 */
const PORT = {
  unitOfWork: UNIT_OF_WORK,
  categories: PLATFORM_CATEGORY_REPOSITORY,
  seed: CATEGORY_SEED,
  attributes: ATTRIBUTE_REPOSITORY,
  attributeSeed: ATTRIBUTE_SEED,
  outbox: OUTBOX_WRITER,
  clock: CLOCK,
  ids: ID_GENERATOR,
} as const satisfies Record<string, InjectionToken>;

type PortName = keyof typeof PORT;

/**
 * The provider of one use case: the gate and the named ports, in a dependency object. `ports`
 * names every key of the use case's own dependency type, each a key of {@link PORT}, and no
 * other: the type checker refuses a missing, unknown or misnamed dependency.
 */
function useCaseProvider<D, U>(
  type: new (gate: UseCaseGate, deps: D) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...names.map((name) => PORT[name])],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(gate, Object.fromEntries(names.map((name, index) => [name, values[index]])) as D),
  };
}

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
 * types; slice 2 adds the category store and the seed job; its other use cases arrive with
 * slices 6 and 7.
 */
@Module({
  providers: [
    PersistenceModule.outboxWriterFor('catalog'),
    registerEvents('catalog', CATALOG_EVENTS),
    productTypeProvider,
    ...catalogProviders,
    useCaseProvider(SeedCategoryTree, {
      unitOfWork: true,
      categories: true,
      seed: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SeedAttributes, {
      unitOfWork: true,
      attributes: true,
      attributeSeed: true,
      clock: true,
      ids: true,
    }),
    registerJobsFrom(
      'catalog',
      [SeedCategoryTree, SeedAttributes],
      (categories: SeedCategoryTree, attributes: SeedAttributes) => [
        seedCategoryTreeJob(categories),
        seedAttributesJob(attributes),
      ],
    ),
  ],
})
export class CatalogModule {}
