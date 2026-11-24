import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  countAdminWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import type {
  ExpiringCertificates,
  ExpiringCertificatesQuery,
} from '../../contracts/certification-work-queue.facade';
import { CERTIFICATION_SELLER_CERTIFICATE_VIEW } from '../../contracts/permissions';
import { EXPIRING_WITHIN_MARKET_DAYS, expiringWindowEnd } from '../../domain/expiring-window';
import type { CertificationWorkQueueCountReader } from '../ports/work-queue-count.reader';

export interface CountExpiringCertificatesDependencies extends WorkQueueCountDependencies<CertificationWorkQueueCountReader> {
  /** The Market's IANA zone (Market configuration): the window is counted in Market days. */
  readonly zoneOf: (market: MarketContext) => string;
}

/**
 * `certification.count-expiring-certificates` (dashboards v2, phase 1, PR 6): how many approved
 * seller certificates expire within the next {@link EXPIRING_WITHIN_MARKET_DAYS} Market days (the
 * admin dashboard's supply and health card). A count only: no seller, type or certificate id leaves
 * the module. Rule: the key `certification.seller-certificate.view`, platform admins acting as
 * themselves only. One read-only unit.
 */
export class CountExpiringCertificates extends UseCase<
  ExpiringCertificatesQuery,
  ExpiringCertificates,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.count-expiring-certificates',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CountExpiringCertificatesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: ExpiringCertificatesQuery,
  ): Promise<Result<ExpiringCertificates, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, async (counts) => {
      const until = expiringWindowEnd(query.now, this.deps.zoneOf(context.market));
      const count = await counts.expiringSellerCertificates(context.market, query.now, until);
      return { count, withinDays: EXPIRING_WITHIN_MARKET_DAYS, until };
    });
  }
}
