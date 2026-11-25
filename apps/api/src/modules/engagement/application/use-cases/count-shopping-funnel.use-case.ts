import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  ShoppingFunnelFailure,
  ShoppingFunnelRequest,
} from '../../contracts/engagement.facade';
import {
  MAX_FUNNEL_ACCOUNTS,
  MAX_FUNNEL_CHECKOUTS,
  MAX_FUNNEL_WINDOW_HOURS,
  shoppingFunnelOf,
  type FunnelCheckout,
  type ShoppingFunnelCounts,
} from '../../domain/shopping-funnel';
import type { EngagementDependencies } from '../engagement-dependencies';

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

/** The request checked whole: a window of at most a long day, and well-formed checkouts. */
function checkedRequest(
  input: ShoppingFunnelRequest,
): { readonly window: ShoppingFunnelRequest['window']; checkouts: FunnelCheckout[] } | null {
  const window = input?.window;
  if (!isInstant(window?.from) || !isInstant(window.to)) {
    return null;
  }
  const span = window.to.epochMilliseconds - window.from.epochMilliseconds;
  if (!(span > 0) || span > MAX_FUNNEL_WINDOW_HOURS * 3_600_000) return null;
  const raw: readonly unknown[] | null = Array.isArray(input.checkouts) ? input.checkouts : null;
  if (raw === null || raw.length > MAX_FUNNEL_CHECKOUTS) return null;
  const checkouts: FunnelCheckout[] = [];
  for (const entry of raw) {
    const checkout = (entry ?? {}) as { readonly accountId?: unknown; readonly paid?: unknown };
    const accountId = parseId<'Account'>(
      typeof checkout.accountId === 'string' ? checkout.accountId : '',
    );
    if (!accountId.ok || typeof checkout.paid !== 'boolean') return null;
    checkouts.push({ accountId: accountId.value, paid: checkout.paid });
  }
  return { window, checkouts };
}

/**
 * `engagement.count-shopping-funnel` (dashboards v2, phase 2): the shopping funnel of one window
 * (a Market day) as four counts of distinct accounts, for reporting's nightly snapshot. Rule
 * `system`. The population is engagement's: signed-in customers with personalization on (only
 * their behaviour is kept; guests are never counted). The caller names the accounts that placed
 * an order in the window (ordering's), which count only when they also viewed a product and added
 * to the cart in it. Only counts are answered; the ids are neither returned nor logged. One
 * read-only unit (ADR-0025). A day with more than {@link MAX_FUNNEL_ACCOUNTS} accounts of a step
 * is `engagement.funnel-too-large`, never a short count.
 */
export class CountShoppingFunnel extends UseCase<
  ShoppingFunnelRequest,
  ShoppingFunnelCounts,
  ShoppingFunnelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.count-shopping-funnel',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ShoppingFunnelRequest,
  ): Promise<Result<ShoppingFunnelCounts, ShoppingFunnelFailure>> {
    const request = checkedRequest(input);
    if (request === null) return err({ code: 'validation.failed' });
    const { market } = context;
    return this.deps.unitOfWork.run<ShoppingFunnelCounts, ShoppingFunnelFailure>(
      market,
      async () => {
        const read = (kind: 'product-viewed' | 'added-to-cart') =>
          this.deps.events.accountsWith(market, kind, request.window, MAX_FUNNEL_ACCOUNTS + 1);
        const viewers = await read('product-viewed');
        const carters = await read('added-to-cart');
        if (viewers.length > MAX_FUNNEL_ACCOUNTS || carters.length > MAX_FUNNEL_ACCOUNTS) {
          return err({ code: 'engagement.funnel-too-large' });
        }
        return ok(
          shoppingFunnelOf(
            new Set<Id<'Account'>>(viewers),
            new Set<Id<'Account'>>(carters),
            request.checkouts,
          ),
        );
      },
      { readOnly: true },
    );
  }
}
