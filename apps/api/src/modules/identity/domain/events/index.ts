import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * Every event identity publishes, declared with `defineEvent` (platform persistence design
 * 5.3; identity design 8.2) and registered with the event catalogue by `IdentityModule`. The
 * first one, the account registration, arrives with slice 1d; each new type changes the
 * catalogue snapshot (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const IDENTITY_EVENTS: readonly EventDefinition[] = [];
