import type { CallContext } from '@mondapac/shared-kernel';

/**
 * The zone a day filter of an admin list is read in (ADR-0005): the calling admin's own panel zone
 * when they chose one, the Market's zone otherwise. Never UTC by default and never a guess: a
 * failed read of the admin's preference falls back to the Market's zone, which always exists.
 */
export interface AdminDayZone {
  zoneOf(context: CallContext): Promise<string>;
}

export const ADMIN_DAY_ZONE = Symbol('ADMIN_DAY_ZONE');
