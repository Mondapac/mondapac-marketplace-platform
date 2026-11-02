import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  SellerLostDisputeCount,
  SellerLostDisputesFailure,
} from '../../contracts/commission-payouts.facade';
import type { DisputeDependencies } from '../dispute-dependencies';

interface Input {
  readonly sellerId?: unknown;
  readonly windows?: unknown;
}

/** The most windows one call may ask for (a few local days). */
export const SELLER_LOST_DISPUTES_MAX_WINDOWS = 8;

/** The most seller-fault decisions of one seller read for the windows; past it the read fails. */
export const SELLER_LOST_DISPUTES_ROW_LIMIT = 20_000;

const instantOf = (value: unknown): Temporal.Instant | null => {
  if (typeof value !== 'string') return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
};

/**
 * `commission-payouts.seller-lost-disputes` (rule `system`): for each window the disputes the
 * seller lost, that is the seller-fault decisions an admin took in it that no later decision
 * reversed. Disputes the seller won, or whose loss the platform bears, are not the seller's
 * fault and do not count. The windows are instants the caller worked out in the seller's own
 * zone (ADR-0005). Counters only: no customer, amount or reason. The nightly seller health job
 * of `sellers` calls it through the facade.
 */
export class SellerLostDisputes extends UseCase<
  Input,
  readonly SellerLostDisputeCount[],
  SellerLostDisputesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.seller-lost-disputes',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DisputeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<readonly SellerLostDisputeCount[], SellerLostDisputesFailure>> {
    const sellerId = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    const raw = input?.windows;
    if (
      sellerId === null ||
      !sellerId.ok ||
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > SELLER_LOST_DISPUTES_MAX_WINDOWS
    ) {
      return err({ code: 'validation.failed' });
    }
    const windows: { from: Temporal.Instant; to: Temporal.Instant }[] = [];
    for (const entry of raw as unknown[]) {
      const w = (entry ?? {}) as { from?: unknown; to?: unknown };
      const from = instantOf(w.from);
      const to = instantOf(w.to);
      if (from === null || to === null || Temporal.Instant.compare(from, to) >= 0) {
        return err({ code: 'validation.failed' });
      }
      windows.push({ from, to });
    }
    const first = windows.reduce(
      (a, w) => (Temporal.Instant.compare(w.from, a) < 0 ? w.from : a),
      windows[0]!.from,
    );
    const last = windows.reduce(
      (a, w) => (Temporal.Instant.compare(w.to, a) > 0 ? w.to : a),
      windows[0]!.to,
    );
    return this.deps.unitOfWork.run<readonly SellerLostDisputeCount[], SellerLostDisputesFailure>(
      context.market,
      async () => {
        const times = await this.deps.disputes.sellerFaultDecisionTimes(
          context.market,
          sellerId.value,
          first,
          last,
          SELLER_LOST_DISPUTES_ROW_LIMIT,
        );
        return ok(
          windows.map((w) => ({
            lost: times.filter(
              (at) =>
                Temporal.Instant.compare(at, w.from) >= 0 && Temporal.Instant.compare(at, w.to) < 0,
            ).length,
          })),
        );
      },
      { readOnly: true },
    );
  }
}
