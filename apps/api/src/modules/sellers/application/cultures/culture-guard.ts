import type { CallContext, Clock, Id } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { demoteMembership, type SellerCultureState } from '../../domain/seller-culture';
import type { CultureDirectory } from '../ports/culture-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import { announce } from './seller-culture-views';

/** An approval just written, and the required certification type it was approved against. */
export interface FreshApproval {
  readonly state: SellerCultureState;
  /** The type the certificate check covered; null when none was required at the time. */
  readonly verifiedType: string | null;
}

export interface CultureGuardDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
  readonly cultureDirectory: CultureDirectory;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

export interface GuardOutcome {
  /** The cultures whose approval was taken back, because the culture changed after the read. */
  readonly demoted: ReadonlySet<Id<'Culture'>>;
  /** True when the cultures could not be read again: every fresh approval was taken back. */
  readonly unreadable: boolean;
}

/**
 * The guard against a stale read (ADR-0048, security review M1). A membership is approved on a read
 * of the culture made before the write, and catalog is another schema, so the write unit cannot read
 * it again. The culture is therefore read again right after the commit, and an approval whose
 * culture is no longer Active, or whose required certification type is no longer the one the
 * approval was checked against, is taken back to requested at once (guarded on the version, with an
 * event). Catalog closes the other side: it refuses to change a required type while anyone is
 * approved, and reverts a change that raced with an approval. If the read fails, every fresh
 * approval is taken back (fail closed). A reviewer then decides again with the seller's certificate.
 */
export async function demoteStaleApprovals(
  deps: CultureGuardDependencies,
  context: CallContext,
  approvals: readonly FreshApproval[],
): Promise<GuardOutcome> {
  if (approvals.length === 0) return { demoted: new Set(), unreadable: false };
  const { market } = context;
  const current = await deps.cultureDirectory.byIds(
    context,
    approvals.map((a) => a.state.cultureId),
  );
  const stale = approvals.filter((a) => {
    if (!current.ok) return true;
    const culture = current.value.get(a.state.cultureId);
    return (
      culture === undefined ||
      culture.status !== 'active' ||
      culture.requiredCertificationType !== a.verifiedType
    );
  });
  const demoted = new Set<Id<'Culture'>>();
  if (stale.length > 0) {
    await deps.unitOfWork.run(market, async () => {
      const at = deps.clock.now();
      for (const { state } of stale) {
        const next = demoteMembership(state, at);
        const won = await deps.sellerCultures.transition(market, next, {
          version: state.version,
          status: 'approved',
        });
        if (!won) continue;
        await announce(deps.outbox, context, next);
        demoted.add(state.cultureId);
      }
      return { ok: true as const, value: undefined };
    });
  }
  return { demoted, unreadable: !current.ok };
}
