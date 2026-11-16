import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';
import { REVIEW_AREAS } from './areas';

// The events system-requests publishes: ids, enums and whole numbers only. Never the note, the
// values before or after, a reason or a comment (those stay in this module's tables). The
// catalogue snapshot (`test/contracts/event-catalogue.snapshot.json`) changes with every type.

/**
 * An open request is past its review date and its reviewers are to be reminded. At most one per
 * request per Market day. Each reminder is its own aggregate (a fresh id, version 1), as the
 * request has no counter of reminders. Notifications turns it into one admin notice.
 */
export const SystemRequestOverdue = defineEvent({
  type: 'system-requests.request-overdue.v1',
  aggregateType: 'request-reminder',
  payload: {
    requestId: eventField.id(),
    number: eventField.integer(),
    area: eventField.enumOf(REVIEW_AREAS),
    /** Whole days since the change went live. */
    ageDays: eventField.integer(),
  },
});

/** Every event system-requests publishes, registered by `SystemRequestsModule`. */
export const SYSTEM_REQUESTS_EVENTS: readonly EventDefinition[] = [SystemRequestOverdue];
