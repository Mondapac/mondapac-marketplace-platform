import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_VIEW } from '../../contracts/permissions';
import {
  listCertificateQueue,
  type CertificateQueueListDependencies,
  type CertificateQueueListFailure,
  type CertificateQueueListInput,
  type CertificateQueueListPage,
} from '../review/certificate-queue-list-flow';

/**
 * `certification.seller-certificates-queue-query` (super list 17): an admin lists the waiting
 * seller-certificate submissions of the Market as the list does. Same key as the older queue
 * (`certification.seller-certificate.view`); it reads the same submissions.
 */
export class SellerCertificatesQueueQuery extends UseCase<
  CertificateQueueListInput,
  CertificateQueueListPage,
  CertificateQueueListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificates-queue-query',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CertificateQueueListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CertificateQueueListInput) {
    return listCertificateQueue(this.deps, context, input);
  }
}
