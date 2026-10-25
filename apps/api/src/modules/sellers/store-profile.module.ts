import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import {
  CERTIFICATION_FACADE,
  CertificationModule,
  type CertificationFacade,
} from '../certification';
import { STORE_TEXT_CLAIM_CHECK } from './application/ports/store-text-claim-check';
import { CertificationStoreTextClaimCheck } from './infrastructure/certification-store-text-claim-check';
import type { LateBoundStoreTextClaimCheck } from './infrastructure/late-bound-store-text-claim-check';
import { SellersModule } from './sellers.module';

/**
 * Binds the claim check of the store profile texts to certification (sellers design 3.7: a store
 * text never claims a certification). It is a module of its own because certification imports
 * sellers: `SellersModule` provides a check that refuses until this module binds the real one at
 * start, and this module (which imports both) is registered beside them in `modules/index.ts`.
 * It is not exported from the sellers entry point, so no file cycle forms.
 */
@Module({ imports: [SellersModule, CertificationModule] })
export class SellerStoreProfileModule implements OnModuleInit {
  constructor(
    @Inject(STORE_TEXT_CLAIM_CHECK) private readonly check: LateBoundStoreTextClaimCheck,
    @Inject(CERTIFICATION_FACADE) private readonly certification: CertificationFacade,
  ) {}

  onModuleInit(): void {
    this.check.bind(new CertificationStoreTextClaimCheck(this.certification));
  }
}
