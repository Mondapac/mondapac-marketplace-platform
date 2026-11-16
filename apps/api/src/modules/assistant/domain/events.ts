import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/** The caps that switch the assistant off for the rest of a day or a month. */
export const SPEND_CAPS = ['daily', 'monthly'] as const;

/**
 * A spend cap switched the Market's buyer assistant off (stage 0, B4): at most once per Market and
 * Market day, written in the unit that counted the turn which reached it. Which cap only: no
 * amount, conversation or buyer; the Market is on the envelope. The aggregate is the Market's
 * spend day, so its version is always 1. Notifications makes it an admin bell notice.
 */
export const AssistantSpendCapReached = defineEvent({
  type: 'assistant.spend-cap-reached.v1',
  aggregateType: 'assistant-spend-day',
  payload: { cap: eventField.enumOf(SPEND_CAPS) },
});

/** Every event type assistant publishes, registered with the event catalogue at boot. */
export const ASSISTANT_EVENTS: readonly EventDefinition[] = [AssistantSpendCapReached];
