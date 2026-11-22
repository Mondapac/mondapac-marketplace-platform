import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountSellerCertificateReviews } from '../application/use-cases/count-seller-certificate-reviews.use-case';
import type { CountProductCertificateReviews } from '../application/use-cases/count-product-certificate-reviews.use-case';
import type { CertificationWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class CertificationWorkQueueFacadeImplementation implements CertificationWorkQueueFacade {
  constructor(
    private readonly sellerCertificatesUseCase: CountSellerCertificateReviews,
    private readonly productCertificatesUseCase: CountProductCertificateReviews,
  ) {}

  sellerCertificates(context: CallContext, query: WorkQueueCountQuery) {
    return this.sellerCertificatesUseCase.execute(context, query);
  }

  productCertificates(context: CallContext, query: WorkQueueCountQuery) {
    return this.productCertificatesUseCase.execute(context, query);
  }
}
