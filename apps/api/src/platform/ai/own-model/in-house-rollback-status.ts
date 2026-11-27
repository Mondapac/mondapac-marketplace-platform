import { Inject, Injectable } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { UNIT_OF_WORK, type UnitOfWork } from '../../unit-of-work/unit-of-work';
import { CAPABILITY_TASKS, type CapabilityTask } from '../capability';
import {
  AI_USAGE_STORE,
  type AiUsageStore,
  type InHouseRollbackRecord,
} from '../usage/ai-usage-store';

/**
 * Whether a task type's latest rollback holds its live stage off: when no admin changed the task
 * type's in-house settings (stage, model or percent share) after it. The gateway's rule
 * (`InHouseRollback.heldOff`, G6d3) and the tab's read ({@link InHouseRollbackStatusRead}, G6e2)
 * share it.
 */
export function heldOffBy(
  rolledBackAt: Temporal.Instant,
  changedAt: Temporal.Instant | undefined,
): boolean {
  return changedAt === undefined || Temporal.Instant.compare(rolledBackAt, changedAt) >= 0;
}

/** A task type's latest rollback and whether it holds the live stage off now (G6e2). */
export interface InHouseRollbackStatus extends Omit<InHouseRollbackRecord, 'id'> {
  readonly heldOff: boolean;
}

/**
 * settings' read of the in-house auto-rollbacks for the Mondapac Intelligence tab (AI Gateway G6e2;
 * docs/design/domain/platform-ai.md section 8, "Built in G6e2"): each task type's latest rollback
 * and whether it holds the live stage off now. Numbers and codes only, never a model's text, and
 * no model call (rule ai-in-house-rollback-status-only-from-settings limits who imports it).
 */
@Injectable()
export class InHouseRollbackStatusRead {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(AI_USAGE_STORE) private readonly store: AiUsageStore,
  ) {}

  /**
   * Given when an admin last changed each task type (settings' `inHouseChangedAt`), the latest
   * rollback of each task type of the Market in task order, a task type never rolled back left
   * out. Read fresh in a read-only unit (not from the gateway's 10 s reuse); throws when it cannot
   * be read.
   */
  async status(
    market: MarketContext,
    changedAt: Readonly<Partial<Record<CapabilityTask, Temporal.Instant>>>,
  ): Promise<readonly InHouseRollbackStatus[]> {
    const read = await this.unitOfWork.run(
      market,
      async () => ok(await this.store.latestInHouseRollbacks(market, CAPABILITY_TASKS)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('the in-house rollbacks could not be read');
    const rows: InHouseRollbackStatus[] = [];
    for (const task of CAPABILITY_TASKS) {
      const row = read.value[task];
      if (row === undefined) continue;
      rows.push({
        task: row.task,
        family: row.family,
        stage: row.stage,
        reason: row.reason,
        calls: row.calls,
        failures: row.failures,
        guardRejected: row.guardRejected,
        errorsLimitPermille: row.errorsLimitPermille,
        guardLimitPermille: row.guardLimitPermille,
        minSample: row.minSample,
        rolledBackAt: row.rolledBackAt,
        heldOff: heldOffBy(row.rolledBackAt, changedAt[task]),
      });
    }
    return rows;
  }
}
