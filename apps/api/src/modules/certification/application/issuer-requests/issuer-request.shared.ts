import { parseId } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { IssuerRequestReasonSpec } from '../../domain/review';
import type { CertificateTypeCatalog } from '../ports/certificate-type-catalog';
import type { SellerZonesSource } from '../ports/claim-facts.ports';
import type {
  CertificateFieldCipher,
  DocumentIntake,
  DocumentVault,
} from '../ports/document-ports';
import type { IssuerRequestRepository } from '../ports/issuer-request.repository';
import type { RateCounterKeys, RateCounterRepository } from '../ports/rate-counters';
import type { ReviewPolicyProvider, ReviewSellerSource } from '../ports/review.ports';

/**
 * The ports of the "my issuer is not listed" use cases (certification design 2.1, 7.2; slice 6),
 * seller and admin side; each takes the whole object and uses its part.
 */
export interface IssuerRequestDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: IssuerRequestRepository;
  readonly types: CertificateTypeCatalog;
  readonly vault: DocumentVault;
  readonly intake: DocumentIntake;
  readonly cipher: CertificateFieldCipher;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly zones: SellerZonesSource;
  readonly sellers: ReviewSellerSource;
  readonly policies: ReviewPolicyProvider;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Whether an admin may read the bytes of a request's file: the same switch as the reviewer's
   * reads of certificate files (`CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED`, off by default).
   */
  readonly documentDownloadEnabled: boolean;
}

export function parseIssuerRequestId(raw: unknown): Id<'IssuerRequest'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'IssuerRequest'>(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseIssuerId(raw: unknown): Id<'Issuer'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'Issuer'>(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * The Market's reasons for a "not accepted" answer, or null when the Market has no review policy
 * (then no reason is known and every such answer is refused: fail closed).
 */
export function issuerRequestReasonsOf(
  deps: Pick<IssuerRequestDependencies, 'policies'>,
  market: MarketContext,
): readonly IssuerRequestReasonSpec[] | null {
  try {
    return deps.policies.policyFor(market).issuerRequestReasons;
  } catch {
    return null;
  }
}
