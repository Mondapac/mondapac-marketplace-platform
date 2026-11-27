import { parseId } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type {
  AiInHouseRollbackNotices,
  InHouseRollbackNotice,
} from '../../../platform/ai/gateway-controls';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { AiInHouseRolledBack } from '../domain/events';

/**
 * settings' side of platform/ai's rollback-notice port (AI Gateway G6e2): appends
 * `settings.ai-in-house-rolled-back.v1` to settings' outbox in the caller's open read-write unit
 * (its own, right after the one that inserts the rollback's row). The aggregate is the rollback
 * (its id, version 1): the outbox's unique (market, aggregate, version) holds it to one event per
 * rollback. Codes only. Notifications turns it into the admin
 * bell notice.
 */
export class SettingsAiInHouseRollbackNotices implements AiInHouseRollbackNotices {
  constructor(private readonly outbox: OutboxWriter) {}

  async rolledBack(context: CallContext, notice: InHouseRollbackNotice): Promise<void> {
    const aggregateId = parseId(notice.rollbackId);
    if (!aggregateId.ok) throw new Error('settings: the rollback id is not a UUID');
    await this.outbox.append(context, [
      AiInHouseRolledBack.record({
        aggregateId: aggregateId.value,
        aggregateVersion: 1,
        occurredAt: notice.rolledBackAt,
        payload: { task: notice.task, stage: notice.stage, reason: notice.reason },
      }),
    ]);
  }
}
