import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { ORDERING_ORDER_VIEW } from '../../../ordering';
import type {
  FinanceAnswer,
  OperationsAnswer,
  PeriodId,
  ReportingKpiFacade,
} from '../../../reporting';
import type { ViewerPermissions } from '../ports/viewer-permissions';

/** How long one KPI read may take before its section answers `error` (design section 6). */
export const KPI_TIMEOUT_MS = 1_500;

/** One section of the KPI answer: its numbers, or `error` when it failed or took too long. */
export type KpiSection<T> =
  { readonly status: 'ok'; readonly value: T } | { readonly status: 'error' };

export interface AdminKpisAnswer {
  readonly generatedAt: Temporal.Instant;
  readonly period: PeriodId;
  /** Null when the viewer does not hold `ordering.order.view` (the section is left out). */
  readonly operations: KpiSection<OperationsAnswer> | null;
  /** Null when the viewer does not hold `commission-payouts.settlement.view`. */
  readonly finance: KpiSection<FinanceAnswer> | null;
}

export interface AdminKpisDependencies {
  readonly viewer: ViewerPermissions;
  readonly reporting: ReportingKpiFacade;
  readonly clock: Clock;
  /** {@link KPI_TIMEOUT_MS} outside tests. */
  readonly timeoutMs: number;
}

const logger = new Logger('AdminKpis');

/** The class name of a thrown value (never its message). */
const nameOf = (error: unknown): string => {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'unknown';
};

/**
 * Runs one read with a time limit. A read the owner refuses (`access.denied`) is left out like a
 * key the viewer does not hold; one that fails, takes too long or throws is `error`, so one slow
 * section never fails the other.
 */
async function section<T>(
  name: string,
  timeoutMs: number,
  read: () => Promise<Result<T, AccessDenied>>,
): Promise<KpiSection<T> | null> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), timeoutMs);
    timer.unref();
  });
  try {
    const answer = await Promise.race([read(), limit]);
    if (answer === 'timed-out') {
      logger.warn({ msg: 'dashboard.admin-kpis.section', section: name, outcome: 'timeout' });
      return { status: 'error' };
    }
    if (answer.ok) return { status: 'ok', value: answer.value };
    if (answer.error.code === 'access.denied') return null;
    logger.warn({ msg: 'dashboard.admin-kpis.section', section: name, outcome: answer.error.code });
    return { status: 'error' };
  } catch (error) {
    logger.warn({
      msg: 'dashboard.admin-kpis.section',
      section: name,
      outcome: 'threw',
      error: nameOf(error),
    });
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET dashboard/admin/kpis` (dashboards upgrade, phase 5): the admin KPI strip and trend. Rule
 * `own-resources` and a platform admin acting as themselves, like the work queue. Each section is
 * asked only when the viewer holds its key (operations: `ordering.order.view`; money:
 * `commission-payouts.settlement.view`) and its owner checks the key again. Nothing is cached
 * here: the numbers are the daily rollups, one grouped read each.
 */
export class ViewAdminKpis extends UseCase<
  { readonly period: PeriodId },
  AdminKpisAnswer,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'dashboard.view-admin-kpis',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminKpisDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly period: PeriodId },
  ): Promise<Result<AdminKpisAnswer, AccessDenied>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const viewer = await this.deps.viewer.describe(context);
    if (!viewer.ok) return err(viewer.error);
    if (viewer.value.population !== 'admin') return err({ code: 'access.denied' });
    const held = new Set(viewer.value.permissionKeys);
    const { reporting, timeoutMs } = this.deps;
    const [operations, finance] = await Promise.all([
      held.has(ORDERING_ORDER_VIEW.key)
        ? section('operations', timeoutMs, () => reporting.marketplaceOperations(context, input))
        : null,
      held.has(COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key)
        ? section('finance', timeoutMs, () => reporting.marketplaceFinance(context, input))
        : null,
    ]);
    return ok({
      generatedAt: this.deps.clock.now(),
      period: input.period,
      operations,
      finance,
    });
  }
}
