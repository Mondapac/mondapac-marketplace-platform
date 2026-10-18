import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { CATALOG_REFERENCES } from '../../certification';
import { PrismaCatalogReferences } from './prisma-catalog-references';

/**
 * Binds `certification`'s `CatalogReferences` port to catalog's adapter (certification design
 * 8.2, request C-3). Global, so `CertificationModule` receives the binding without importing
 * `catalog` (catalog imports certification; ADR-0028 d9). Imported once, by `CatalogModule`;
 * without it the application does not start (an unbound port fails boot).
 */
@Global()
@Module({
  providers: [
    {
      provide: CATALOG_REFERENCES,
      inject: [UNIT_OF_WORK, PrismaService],
      useFactory: (unitOfWork: UnitOfWork, prisma: PrismaService) =>
        new PrismaCatalogReferences(unitOfWork, prisma),
    },
  ],
  exports: [CATALOG_REFERENCES],
})
export class CatalogReferencesModule {}
