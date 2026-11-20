import type { ReviewArea } from '../domain/areas';

/** Which modules may register kinds in an area (by module name). */
export type AreaOwners = Readonly<Record<ReviewArea, readonly string[]>>;

/**
 * The modules that own each reviewed area (docs/modules/system-requests/notes.md, "Hooked
 * areas"): a module registers kinds only in an area listed for it here, so a module cannot file
 * its changes under another module's area (and its reviewers). A module that hooks a new area is
 * added here in the same change, which makes the new owner part of that change's review. The
 * review policy is system-requests' own; content has no owner yet.
 */
export const AREA_OWNERS: AreaOwners = Object.freeze({
  people: Object.freeze(['identity']),
  money: Object.freeze(['commission-payouts', 'wallet']),
  delivery: Object.freeze(['shipping']),
  catalogue: Object.freeze(['catalog']),
  certification: Object.freeze(['certification']),
  marketplace: Object.freeze(['settings']),
  content: Object.freeze([]),
  'review-policy': Object.freeze(['system-requests']),
});
