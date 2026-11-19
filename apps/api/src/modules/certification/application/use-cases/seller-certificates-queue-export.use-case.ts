import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_VIEW } from '../../contracts/permissions';
import {
  exportCertificateQueue,
  type CertificateQueueListDependencies,
  type CertificateQueueListFailure,
  type CertificateQueueListInput,
} from '../review/certificate-queue-list-flow';

/**
 * `certification.seller-certificates-queue-export` (super list 17): an admin exports the waiting
 * seller-certificate submissions of the Market as the list does. Same key as the older queue
 * (`certification.seller-certificate.view`); it reads the same submissions.
 */
export class SellerCertificatesQueueExport extends UseCase<
  CertificateQueueListInput,
  ExportFile,
  CertificateQueueListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificates-queue-export',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CertificateQueueListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CertificateQueueListInput) {
    return exportCertificateQueue(this.deps, context, input);
  }
}
