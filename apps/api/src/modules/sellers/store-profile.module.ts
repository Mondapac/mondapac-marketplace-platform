import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import {
  CATALOG_ACTIVITIES_FACADE,
  CATALOG_CULTURES_FACADE,
  CatalogModule,
  type CatalogActivitiesFacade,
  type CatalogCulturesFacade,
} from '../catalog';
import {
  CERTIFICATION_FACADE,
  CertificationModule,
  type CertificationFacade,
} from '../certification';
import { BUSINESS_ACTIVITY_DIRECTORY } from './application/ports/business-activity-directory';
import { CULTURE_DIRECTORY } from './application/ports/culture-directory';
import { SELLER_CERTIFICATE_DIRECTORY } from './application/ports/seller-certificate-directory';
import { CatalogCultureDirectory } from './infrastructure/catalog-culture-directory';
import { CertificationSellerCertificateDirectory } from './infrastructure/certification-seller-certificate-directory';
import type {
  LateBoundCultureDirectory,
  LateBoundSellerCertificateDirectory,
} from './infrastructure/late-bound-directories';
import { STORE_TEXT_CLAIM_CHECK } from './application/ports/store-text-claim-check';
import { CatalogBusinessActivityDirectory } from './infrastructure/catalog-business-activity-directory';
import { CertificationStoreTextClaimCheck } from './infrastructure/certification-store-text-claim-check';
import type { LateBoundBusinessActivityDirectory } from './infrastructure/late-bound-business-activity-directory';
import type { LateBoundStoreTextClaimCheck } from './infrastructure/late-bound-store-text-claim-check';
import { SellersModule } from './sellers.module';

/**
 * Binds the late-bound ports of sellers whose other side imports sellers:
 * - the claim check of the store profile texts to certification (sellers design 3.7: a store
 *   text never claims a certification);
 * - the business-activity directory to catalog's `activeBusinessActivityIds` (ADR-0040 decision 4:
 *   catalog owns the activities, sellers owns the assignment);
 * - the culture directory to catalog's `culturesByIds` and the seller-certificate directory to
 *   certification's `sellerCertificateOverview` (ADR-0047 decision 3: a membership in a culture
 *   with a required certification type needs the seller's valid certificate).
 * It is a module of its own because certification and catalog import sellers: `SellersModule`
 * provides ports that refuse until this module binds the real ones at start, and this module
 * (which imports all three) is registered beside them in `modules/index.ts`. It is not exported
 * from the sellers entry point, so no file cycle forms.
 */
@Module({ imports: [SellersModule, CertificationModule, CatalogModule] })
export class SellerStoreProfileModule implements OnModuleInit {
  constructor(
    @Inject(STORE_TEXT_CLAIM_CHECK) private readonly check: LateBoundStoreTextClaimCheck,
    @Inject(CERTIFICATION_FACADE) private readonly certification: CertificationFacade,
    @Inject(BUSINESS_ACTIVITY_DIRECTORY)
    private readonly activityDirectory: LateBoundBusinessActivityDirectory,
    @Inject(CATALOG_ACTIVITIES_FACADE) private readonly catalog: CatalogActivitiesFacade,
    @Inject(CULTURE_DIRECTORY) private readonly cultureDirectory: LateBoundCultureDirectory,
    @Inject(SELLER_CERTIFICATE_DIRECTORY)
    private readonly certificateDirectory: LateBoundSellerCertificateDirectory,
    @Inject(CATALOG_CULTURES_FACADE) private readonly cultures: CatalogCulturesFacade,
  ) {}

  onModuleInit(): void {
    this.check.bind(new CertificationStoreTextClaimCheck(this.certification));
    this.activityDirectory.bind(new CatalogBusinessActivityDirectory(this.catalog));
    this.cultureDirectory.bind(new CatalogCultureDirectory(this.cultures));
    this.certificateDirectory.bind(new CertificationSellerCertificateDirectory(this.certification));
  }
}
