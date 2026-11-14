import type { MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * The read side of `platform.security_events` for the rules of SOC package 2
 * (docs/design/data/security.md 3). Implemented in `platform/persistence/audit/` (the tables are
 * reserved to that folder) and bound only into the `security` module with
 * `PersistenceModule.securityEventFeedFor('security')`: no other module reads events.
 *
 * Every read runs in the caller's open unit (read-only is enough) and is pinned to its Market. It
 * answers counts, keys and instants only: never a payload, an actor or a correlation id.
 */
export interface SecurityEventFeed {
  /**
   * The keys that have at least `minCount` events of the selection in [since, until), with their
   * count and first and last instants, most events first, at most `limit` keys. `groupBy` is the
   * event's target id (`account`), its address (`ip`) or nothing (`market`: one group, keyed by
   * the Market code). Events without the grouped value are not counted.
   */
  groups(
    market: MarketContext,
    query: SecurityEventGroupQuery,
  ): Promise<readonly SecurityEventGroup[]>;

  /** The events of the selection in [since, until), oldest first, at most `limit`. */
  events(
    market: MarketContext,
    query: SecurityEventListQuery,
  ): Promise<readonly SecurityEventRef[]>;

  /** How many events of the selection, with the given target or address, are in [since, until). */
  count(market: MarketContext, query: SecurityEventCountQuery): Promise<number>;
}

/** Nest token of the {@link SecurityEventFeed}; bound only into the `security` module. */
export const SECURITY_EVENT_FEED = Symbol('SECURITY_EVENT_FEED');

/** The largest `limit` a read may ask for. */
export const MAX_SECURITY_FEED_ROWS = 500;

/** Which events: types of the catalogue, a window, and optional equal payload fields. */
export interface SecurityEventSelection {
  /** 1 to 16 types. */
  readonly types: readonly string[];
  readonly since: Temporal.Instant;
  readonly until: Temporal.Instant;
  /**
   * Payload fields that must equal the given code (a declared enum field such as `population`).
   * At most 2 entries.
   */
  readonly payloadEquals?: Readonly<Record<string, string>>;
}

export type SecurityEventGroupBy = 'account' | 'ip' | 'market';

export interface SecurityEventGroupQuery extends SecurityEventSelection {
  readonly groupBy: SecurityEventGroupBy;
  readonly minCount: number;
  readonly limit: number;
}

export interface SecurityEventGroup {
  /** The target id, the address in canonical text, or the Market code. */
  readonly key: string;
  readonly count: number;
  readonly firstAt: Temporal.Instant;
  readonly lastAt: Temporal.Instant;
}

export interface SecurityEventListQuery extends SecurityEventSelection {
  readonly limit: number;
}

/** An event as the rules see it: its id, target and instant. */
export interface SecurityEventRef {
  readonly id: string;
  readonly targetId: string | null;
  readonly occurredAt: Temporal.Instant;
}

export interface SecurityEventCountQuery extends SecurityEventSelection {
  /** Count only the events with this target id (`account`) or address (`ip`). */
  readonly key: { readonly kind: 'account' | 'ip'; readonly value: string } | null;
}
