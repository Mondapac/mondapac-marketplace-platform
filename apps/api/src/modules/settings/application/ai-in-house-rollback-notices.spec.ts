import { encodePayload, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, PendingEvent } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { SETTINGS_EVENTS } from '../domain/events';
import { SettingsAiInHouseRollbackNotices } from './ai-in-house-rollback-notices';

/** Collects events, each checked against settings' catalogue as the outbox writer does. */
class RecordingOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];
  append(_context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const definition = SETTINGS_EVENTS.find((d) => d.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, {
        isKnownPermissionKey: () => false,
      });
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push(event);
    }
    return Promise.resolve();
  }
}

// AI Gateway G6e2: settings' side of platform/ai's rollback-notice port writes one event per
// rollback, codes only, aggregated on the rollback's id. Both Market fixtures.
describe.each([['AU'], ['ZZ']] as const)('the in-house rollback notices in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const context = testCallContext(market, 'system', 'rollback-0001');
  const ROLLBACK_ID = '0193aaaa-0000-7000-8000-000000000001';
  const AT = Temporal.Instant.from('2026-11-27T10:00:00Z');

  it('appends settings.ai-in-house-rolled-back.v1 with the task type, stage and reason only', async () => {
    const outbox = new RecordingOutbox();
    await new SettingsAiInHouseRollbackNotices(outbox).rolledBack(context, {
      rollbackId: ROLLBACK_ID,
      task: 'vision',
      stage: 'default',
      reason: 'guard',
      rolledBackAt: AT,
    });
    expect(outbox.events).toEqual([
      expect.objectContaining({
        type: 'settings.ai-in-house-rolled-back.v1',
        aggregateType: 'ai-in-house-rollback',
        aggregateId: ROLLBACK_ID,
        aggregateVersion: 1,
        occurredAt: AT,
        payload: { task: 'vision', stage: 'default', reason: 'guard' },
      }),
    ]);
  });

  it('refuses a rollback id that is not a UUID and writes nothing', async () => {
    const outbox = new RecordingOutbox();
    await expect(
      new SettingsAiInHouseRollbackNotices(outbox).rolledBack(context, {
        rollbackId: 'not-a-uuid',
        task: 'chat',
        stage: 'percent',
        reason: 'errors',
        rolledBackAt: AT,
      }),
    ).rejects.toThrow();
    expect(outbox.events).toEqual([]);
  });
});
