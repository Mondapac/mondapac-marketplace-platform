// The Offer review standing of a seller and the flags read with it (apps/api catalog
// offer-review-flags.controller.ts, sellers offer-review-flags.controller.ts).

export const STANDING_VIEW_PERMISSIONS = [
  'catalog.product.approve',
  'sellers.seller.view',
] as const;
export const standingPath = (sellerId: string): string =>
  `catalog/admin/sellers/${sellerId}/review-standing`;
export const flagsPath = (sellerId: string): string => `sellers/admin/${sellerId}/offer-review`;

export interface Standing {
  readonly status: 'trusted' | 'probation';
  readonly source: 'count' | 'admin' | null;
  readonly trustedSince: string | null;
  readonly count: number;
  readonly target: number;
  readonly targetKind: 'initial' | 'after-misconduct';
  readonly consecutiveChangesNeeded: number;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

export function standingOf(body: unknown): Standing | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = body as Record<string, unknown>;
  const count = int(v['count']);
  const target = int(v['target']);
  if (
    (v['status'] !== 'trusted' && v['status'] !== 'probation') ||
    count === null ||
    target === null
  ) {
    return null;
  }
  return {
    status: v['status'],
    source: v['source'] === 'count' || v['source'] === 'admin' ? v['source'] : null,
    trustedSince: str(v['trustedSince']),
    count,
    target,
    targetKind: v['targetKind'] === 'after-misconduct' ? 'after-misconduct' : 'initial',
    consecutiveChangesNeeded: int(v['consecutiveChangesNeeded']) ?? 0,
  };
}

export const FLAG_IDS = ['trusted', 'full-review', 'stop'] as const;
export type FlagId = (typeof FLAG_IDS)[number];

export interface Flag {
  readonly on: boolean;
  readonly changedAt: string | null;
}
export interface Flags {
  readonly trusted: Flag;
  readonly 'full-review': Flag;
  readonly stop: Flag;
  /** The expectedVersion of the next change. */
  readonly version: number;
}

const flagOf = (value: unknown): Flag | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { on, changedAt } = value as Record<string, unknown>;
  return typeof on === 'boolean' ? { on, changedAt: str(changedAt) } : null;
};

export function flagsOf(body: unknown): Flags | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = body as Record<string, unknown>;
  const trusted = flagOf(v['trustedFromStart']);
  const full = flagOf(v['fullReview']);
  const stop = flagOf(v['reviewStop']);
  const version = v['version'];
  if (trusted === null || full === null || stop === null || typeof version !== 'number')
    return null;
  return { trusted, 'full-review': full, stop, version };
}

export const FLAG_PERMISSIONS: Readonly<Record<FlagId, string>> = {
  trusted: 'sellers.offer-review-trust.manage',
  'full-review': 'sellers.offer-review-full.manage',
  stop: 'sellers.offer-review-stop.manage',
};
export const FLAG_PATH_PART: Readonly<Record<FlagId, string>> = {
  trusted: 'trusted',
  'full-review': 'full-review',
  stop: 'stop',
};
export const SELLER_VIEW_PERMISSION = 'sellers.seller.view';
