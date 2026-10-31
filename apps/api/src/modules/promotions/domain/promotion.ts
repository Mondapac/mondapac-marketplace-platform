import { err, ok, parseId, parseMinorUnits, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { PromotionType, Reward } from './calculation/types';

// The promotion aggregate's vocabulary and rules (promotions package T1): what a promotion is,
// how a draft from a seller or an admin is parsed and checked, which layer a type belongs to,
// who must approve before it goes live and when a fresh two-step code is needed. Pure: the
// Market's numbers come in as {@link PromotionRules}.

export const PROMOTION_STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'REJECTED'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const FUNDINGS = ['SELLER', 'PLATFORM', 'CO_FUNDED'] as const;
export type Funding = (typeof FUNDINGS)[number];

/** The types a person creates; the first-order discount comes from the Market's settings. */
export const CREATABLE_TYPES = [
  'SELLER_SALE',
  'CART_DISCOUNT',
  'CART_CODE',
  'FREE_SHIPPING',
  'CO_FUNDED_CAMPAIGN',
  // Phase 2.
  'TIERED_CART',
  'BUY_X_GET_Y',
  'MULTI_BUY',
  'BUNDLE',
  'FLASH_SALE',
  'BATCH_CODE',
] as const satisfies readonly PromotionType[];
export type CreatableType = (typeof CREATABLE_TYPES)[number];

export const REWARD_KINDS = ['PERCENT', 'FIXED'] as const;
export const PAUSED_BY = ['ADMIN', 'SELLER'] as const;
export type PausedBy = (typeof PAUSED_BY)[number];

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

/** The Market's numbers for the rules below (Market config `promotions`). */
export interface PromotionRules {
  readonly sellerMaxDiscountBps: number;
  readonly priorApprovalDiscountBps: number;
  readonly newSellerDays: number;
  readonly platformBudgetStepUpMinor: bigint;
  readonly gstRulingConfirmed: boolean;
}

/** One tier of a tiered cart discount: the goods amount it starts at and its reward. */
export interface TierDraft {
  readonly thresholdMinor: bigint;
  readonly reward: Reward;
}

/** One item of a bundle: a product and how many units of it make one set. */
export interface BundleItemDraft {
  readonly productId: Id<'Product'>;
  readonly quantity: number;
}

export interface PromotionDraft {
  readonly type: CreatableType;
  readonly name: string;
  readonly funding: Funding;
  readonly platformSplitBps: number | null;
  readonly combinable: boolean;
  readonly code: string | null;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant | null;
  readonly testMode: boolean;
  readonly specialCampaign: boolean;
  readonly reward: Reward;
  readonly capMinor: bigint | null;
  readonly maxPerOrderMinor: bigint | null;
  readonly maxTotalUses: number | null;
  readonly maxUsesPerCustomer: number | null;
  readonly budgetMinor: bigint | null;
  readonly minSpendMinor: bigint | null;
  /** Empty is any product. */
  readonly productIds: readonly Id<'Product'>[];
  /** Empty is any seller (a co-funded campaign still needs the sellers' opt-in). */
  readonly sellerIds: readonly Id<'Seller'>[];
  /** Empty is any delivery zone. */
  readonly zones: readonly string[];
  // Phase 2 parameters, set for their type only (checkDraft). The reward of a TIERED_CART is its
  // highest tier; the reward of a MULTI_BUY is FIXED with the price of one group; the reward of a
  // BUNDLE is FIXED with the amount off one set; the reward of BUY_X_GET_Y and FLASH_SALE is per
  // unit (PERCENT or FIXED off the unit price).
  /** TIERED_CART: the tiers, lowest threshold first. */
  readonly tiers: readonly TierDraft[];
  /** BUY_X_GET_Y: buy this many units... */
  readonly buyQty: number | null;
  /** ...and the cheapest this many more get the reward. */
  readonly getQty: number | null;
  /** MULTI_BUY: units in one group. */
  readonly groupQty: number | null;
  /** BUNDLE: the items of one set (also the promotion's product targets). */
  readonly bundleItems: readonly BundleItemDraft[];
  /** BUY_X_GET_Y, MULTI_BUY, BUNDLE: the most groups or sets in one order; null for no limit. */
  readonly maxRepeatsPerOrder: number | null;
  /** FLASH_SALE: the units the sale may sell in all. */
  readonly flashUnitLimit: number | null;
  /** FLASH_SALE: the IANA zone of the owning party, in which the window was written. */
  readonly flashTimeZone: string | null;
}

/** A stored promotion. */
export interface PromotionRecord extends PromotionDraft {
  readonly id: Id<'Promotion'>;
  readonly status: PromotionStatus;
  /** Null for a platform promotion. */
  readonly ownerSellerId: Id<'Seller'> | null;
  readonly currency: string;
  /** An admin approved (or reviewed) this exact promotion; lifts the cautious limit of a seller's fixed reward. */
  readonly priorApproved: boolean;
  readonly pausedBy: PausedBy | null;
  readonly createdByAccountId: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export type Owner =
  { readonly kind: 'platform' } | { readonly kind: 'seller'; readonly sellerId: Id<'Seller'> };

export const MAX_NAME_LENGTH = 120;
export const MAX_PRODUCT_TARGETS = 500;
export const MAX_SELLER_TARGETS = 100;
export const MAX_ZONE_TARGETS = 50;
export const MAX_BPS = 10000;
export const MAX_TIERS = 10;
export const MAX_BUNDLE_ITEMS = 20;
/** The most units a group, a set, a repeat limit or a quantity in a bundle may name. */
export const MAX_UNITS = 1000;
/** Types only a seller makes, types only an admin makes (the rest either, with the owner's money). */
export const SELLER_ONLY_TYPES: readonly CreatableType[] = [
  'SELLER_SALE',
  'BUY_X_GET_Y',
  'MULTI_BUY',
  'BUNDLE',
];
export const ADMIN_ONLY_TYPES: readonly CreatableType[] = [
  'FREE_SHIPPING',
  'CO_FUNDED_CAMPAIGN',
  'TIERED_CART',
  'BATCH_CODE',
];
/** Types an owner must aim at products (a seller's own; the platform's flash sale names them too). */
const NEEDS_PRODUCTS: readonly CreatableType[] = [
  'SELLER_SALE',
  'BUY_X_GET_Y',
  'MULTI_BUY',
  'FLASH_SALE',
];
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
const ZONE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_COUNT = 2_000_000_000;

/** The layer a type belongs to; an owner decides between the seller cart and the platform cart. */
export function layerOf(
  type: PromotionType,
  owner: Owner | 'seller' | 'platform',
): 'ITEM' | 'SELLER_CART' | 'PLATFORM_CART' | 'SHIPPING' {
  const kind = typeof owner === 'string' ? owner : owner.kind;
  switch (type) {
    case 'SELLER_SALE':
    case 'CO_FUNDED_CAMPAIGN':
    case 'BUY_X_GET_Y':
    case 'MULTI_BUY':
    case 'BUNDLE':
    case 'FLASH_SALE':
      return 'ITEM';
    case 'CART_DISCOUNT':
    case 'CART_CODE':
      return kind === 'seller' ? 'SELLER_CART' : 'PLATFORM_CART';
    case 'FIRST_ORDER':
    case 'TIERED_CART':
    case 'BATCH_CODE':
      return 'PLATFORM_CART';
    case 'FREE_SHIPPING':
      return 'SHIPPING';
  }
}

/** The platform's share of a promotion's discounts, in basis points. */
export function platformShareBps(funding: Funding, splitBps: number | null): number {
  if (funding === 'SELLER') return 0;
  if (funding === 'PLATFORM') return MAX_BPS;
  return splitBps ?? 0;
}

/** Normalises a typed code: trimmed, upper case. */
export const normaliseCode = (text: string): string => text.trim().toUpperCase();

export const isCodeShape = (code: string): boolean => CODE_PATTERN.test(code);

/** The platform's money at stake in a budget (what a fresh two-step code protects). */
export function platformExposure(
  funding: Funding,
  splitBps: number | null,
  budget: bigint | null,
): bigint {
  if (budget === null) return 0n;
  return (budget * BigInt(platformShareBps(funding, splitBps))) / 10000n;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIn = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

function plainName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || /\p{C}/u.test(text)) return null;
  return text;
}

function optionalMoney(
  raw: unknown,
  path: string,
  issues: FieldIssue[],
  { min }: { min: bigint },
): bigint | null {
  if (raw === undefined || raw === null) return null;
  const parsed = parseMinorUnits(raw);
  if (!parsed.ok || parsed.value < min) {
    issues.push({ path, code: 'value' });
    return null;
  }
  return parsed.value;
}

function optionalCount(raw: unknown, path: string, issues: FieldIssue[]): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_COUNT) {
    issues.push({ path, code: 'value' });
    return null;
  }
  return raw;
}

function instantOf(raw: unknown): Temporal.Instant | null {
  if (typeof raw !== 'string') return null;
  try {
    return Temporal.Instant.from(raw);
  } catch {
    return null;
  }
}

function idList<K extends string>(
  raw: unknown,
  path: string,
  max: number,
  issues: FieldIssue[],
): Id<K>[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max) {
    issues.push({ path, code: Array.isArray(raw) ? 'too-many' : 'type' });
    return [];
  }
  const out: Id<K>[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = typeof item === 'string' ? parseId<K>(item) : null;
    if (parsed === null || !parsed.ok) {
      issues.push({ path: `${path}.${index}`, code: 'value' });
    } else if (!out.includes(parsed.value)) {
      out.push(parsed.value);
    }
  }
  return out;
}

function parseReward(raw: unknown, path: string, issues: FieldIssue[]): Reward | null {
  if (!isRecord(raw) || !isIn(REWARD_KINDS, raw.kind)) {
    issues.push({ path, code: 'value' });
    return null;
  }
  if (raw.kind === 'PERCENT') {
    const bps = raw.bps;
    if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 1 || bps > MAX_BPS) {
      issues.push({ path: `${path}.bps`, code: 'value' });
      return null;
    }
    return { kind: 'PERCENT', bps };
  }
  const amount = parseMinorUnits(raw.amountMinor);
  if (!amount.ok || amount.value < 1n) {
    issues.push({ path: `${path}.amountMinor`, code: 'value' });
    return null;
  }
  return { kind: 'FIXED', amount: amount.value };
}

function boundedCount(
  raw: unknown,
  path: string,
  issues: FieldIssue[],
  max: number,
): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) {
    issues.push({ path, code: 'value' });
    return null;
  }
  return raw;
}

function parseTiers(raw: unknown, issues: FieldIssue[]): TierDraft[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TIERS) {
    issues.push({ path: 'tiers', code: Array.isArray(raw) ? 'too-many' : 'type' });
    return [];
  }
  const tiers: TierDraft[] = [];
  for (const [index, item] of raw.entries()) {
    const at = `tiers.${index}`;
    if (!isRecord(item)) {
      issues.push({ path: at, code: 'type' });
      continue;
    }
    const threshold = parseMinorUnits(item.thresholdMinor);
    if (!threshold.ok || threshold.value < 1n)
      issues.push({ path: `${at}.thresholdMinor`, code: 'value' });
    const reward = parseReward(item.reward, `${at}.reward`, issues);
    if (threshold.ok && threshold.value >= 1n && reward !== null) {
      tiers.push({ thresholdMinor: threshold.value, reward });
    }
  }
  return tiers.sort((a, b) =>
    a.thresholdMinor < b.thresholdMinor ? -1 : a.thresholdMinor > b.thresholdMinor ? 1 : 0,
  );
}

function parseBundleItems(raw: unknown, issues: FieldIssue[]): BundleItemDraft[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BUNDLE_ITEMS) {
    issues.push({ path: 'bundleItems', code: Array.isArray(raw) ? 'too-many' : 'type' });
    return [];
  }
  const items: BundleItemDraft[] = [];
  for (const [index, item] of raw.entries()) {
    const at = `bundleItems.${index}`;
    if (!isRecord(item)) {
      issues.push({ path: at, code: 'type' });
      continue;
    }
    const productId =
      typeof item.productId === 'string' ? parseId<'Product'>(item.productId) : null;
    if (productId === null || !productId.ok) {
      issues.push({ path: `${at}.productId`, code: 'value' });
      continue;
    }
    if (items.some((other) => other.productId === productId.value)) {
      issues.push({ path: `${at}.productId`, code: 'duplicate' });
      continue;
    }
    const quantity = boundedCount(item.quantity ?? 1, `${at}.quantity`, issues, MAX_UNITS);
    if (quantity !== null) items.push({ productId: productId.value, quantity });
  }
  return items.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
}

/** The IANA zone a flash window is written in: a zone this runtime knows, in its canonical spelling. */
function zoneOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  try {
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(raw).timeZoneId;
  } catch {
    return null;
  }
}

/**
 * A flash sale's wall-clock time in the owning party's zone, as an instant. A time that does not
 * exist or happens twice in that zone (a clock change) is refused, never guessed.
 */
function localInstant(raw: unknown, zone: string): Temporal.Instant | null {
  if (typeof raw !== 'string') return null;
  try {
    return Temporal.PlainDateTime.from(raw, { overflow: 'reject' })
      .toZonedDateTime(zone, { disambiguation: 'reject' })
      .toInstant();
  } catch {
    return null;
  }
}

/**
 * Reads a draft from an untrusted body: types, shapes and sizes only. Amounts arrive as digit
 * strings of minor units (ADR-0007), instants as ISO text. Business rules are
 * {@link checkDraft}. Issues carry a path and a code, never the value.
 */
export function parseDraft(raw: unknown): Result<PromotionDraft, readonly FieldIssue[]> {
  const issues: FieldIssue[] = [];
  if (!isRecord(raw)) return err([{ path: '', code: 'type' }]);

  const type = isIn(CREATABLE_TYPES, raw.type) ? raw.type : null;
  if (type === null) issues.push({ path: 'type', code: 'value' });
  const name = plainName(raw.name);
  if (name === null)
    issues.push({ path: 'name', code: raw.name === undefined ? 'required' : 'value' });
  else if (name.length > MAX_NAME_LENGTH) issues.push({ path: 'name', code: 'too-long' });
  const funding = isIn(FUNDINGS, raw.funding) ? raw.funding : null;
  if (funding === null) issues.push({ path: 'funding', code: 'value' });

  let platformSplit: number | null = null;
  if (raw.platformSplitBps !== undefined && raw.platformSplitBps !== null) {
    const split = raw.platformSplitBps;
    if (typeof split !== 'number' || !Number.isInteger(split) || split < 1 || split > MAX_BPS - 1) {
      issues.push({ path: 'platformSplitBps', code: 'value' });
    } else {
      platformSplit = split;
    }
  }

  const bool = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      issues.push({ path: key, code: 'value' });
      return fallback;
    }
    return value;
  };
  const combinable = bool('combinable', true);
  const testMode = bool('testMode', false);
  const specialCampaign = bool('specialCampaign', false);

  let code: string | null = null;
  if (raw.code !== undefined && raw.code !== null) {
    if (typeof raw.code !== 'string' || !CODE_PATTERN.test(normaliseCode(raw.code))) {
      issues.push({ path: 'code', code: 'value' });
    } else {
      code = normaliseCode(raw.code);
    }
  }

  // A flash sale carries its limit and the zone of the owning party; its window may be written as
  // wall-clock times in that zone (stored as the instants they are) or as instants.
  let flashUnitLimit: number | null = null;
  let flashTimeZone: string | null = null;
  let flashStart: Temporal.Instant | null = null;
  let flashEnd: Temporal.Instant | null = null;
  const rawFlash = raw.flash;
  if (rawFlash !== undefined && rawFlash !== null) {
    if (!isRecord(rawFlash)) {
      issues.push({ path: 'flash', code: 'type' });
    } else {
      flashUnitLimit = boundedCount(rawFlash.unitLimit, 'flash.unitLimit', issues, MAX_COUNT);
      if (flashUnitLimit === null && rawFlash.unitLimit === undefined) {
        issues.push({ path: 'flash.unitLimit', code: 'required' });
      }
      flashTimeZone = zoneOf(rawFlash.timeZone);
      if (flashTimeZone === null) {
        issues.push({
          path: 'flash.timeZone',
          code: rawFlash.timeZone === undefined ? 'required' : 'value',
        });
      }
      const hasLocal = rawFlash.startsLocal !== undefined || rawFlash.endsLocal !== undefined;
      if (hasLocal && flashTimeZone !== null) {
        flashStart = localInstant(rawFlash.startsLocal, flashTimeZone);
        flashEnd = localInstant(rawFlash.endsLocal, flashTimeZone);
        if (flashStart === null) issues.push({ path: 'flash.startsLocal', code: 'value' });
        if (flashEnd === null) issues.push({ path: 'flash.endsLocal', code: 'value' });
        if (raw.startsAt !== undefined) issues.push({ path: 'startsAt', code: 'not-allowed' });
        if (raw.endsAt !== undefined && raw.endsAt !== null) {
          issues.push({ path: 'endsAt', code: 'not-allowed' });
        }
      }
    }
  }

  const startsAt = flashStart ?? instantOf(raw.startsAt);
  if (
    startsAt === null &&
    flashStart === null &&
    !issues.some((i) => i.path.startsWith('flash.starts'))
  ) {
    issues.push({ path: 'startsAt', code: raw.startsAt === undefined ? 'required' : 'value' });
  }
  let endsAt: Temporal.Instant | null = flashEnd;
  if (flashEnd === null && raw.endsAt !== undefined && raw.endsAt !== null) {
    endsAt = instantOf(raw.endsAt);
    if (endsAt === null) issues.push({ path: 'endsAt', code: 'value' });
  }

  // The reward of a tiered cart and of a multi-buy is derived from their own fields.
  const tiers = parseTiers(raw.tiers, issues);
  const groupPrice = optionalMoney(raw.groupPriceMinor, 'groupPriceMinor', issues, { min: 1n });
  let reward: Reward | null = null;
  if (type === 'TIERED_CART' || type === 'MULTI_BUY') {
    if (raw.reward !== undefined) issues.push({ path: 'reward', code: 'not-allowed' });
    if (type === 'TIERED_CART') {
      const top = tiers.at(-1);
      if (top !== undefined) reward = top.reward;
      else if (!issues.some((issue) => issue.path.startsWith('tiers'))) {
        issues.push({ path: 'tiers', code: 'required' });
      }
    } else if (groupPrice !== null) {
      reward = { kind: 'FIXED', amount: groupPrice };
    } else if (raw.groupPriceMinor === undefined) {
      issues.push({ path: 'groupPriceMinor', code: 'required' });
    }
  } else {
    reward = parseReward(raw.reward, 'reward', issues);
  }

  const capMinor = optionalMoney(raw.capMinor, 'capMinor', issues, { min: 1n });
  const maxPerOrderMinor = optionalMoney(raw.maxPerOrderMinor, 'maxPerOrderMinor', issues, {
    min: 1n,
  });
  const budgetMinor = optionalMoney(raw.budgetMinor, 'budgetMinor', issues, { min: 1n });
  const minSpendMinor = optionalMoney(raw.minSpendMinor, 'minSpendMinor', issues, { min: 0n });
  const maxTotalUses = optionalCount(raw.maxTotalUses, 'maxTotalUses', issues);
  const maxUsesPerCustomer = optionalCount(raw.maxUsesPerCustomer, 'maxUsesPerCustomer', issues);

  const buyQty = boundedCount(raw.buyQty, 'buyQty', issues, MAX_UNITS);
  const getQty = boundedCount(raw.getQty, 'getQty', issues, MAX_UNITS);
  const groupQty = boundedCount(raw.groupQty, 'groupQty', issues, MAX_UNITS);
  const maxRepeatsPerOrder = boundedCount(
    raw.maxRepeatsPerOrder,
    'maxRepeatsPerOrder',
    issues,
    MAX_UNITS,
  );
  const bundleItems = parseBundleItems(raw.bundleItems, issues);
  if (type === 'BUNDLE' && raw.bundleItems === undefined) {
    issues.push({ path: 'bundleItems', code: 'required' });
  }
  // The products of a bundle are its items: they cannot be named twice.
  if (type === 'BUNDLE' && raw.productIds !== undefined && raw.productIds !== null) {
    issues.push({ path: 'productIds', code: 'not-allowed' });
  }
  const productIds =
    type === 'BUNDLE'
      ? bundleItems.map((item) => item.productId)
      : idList<'Product'>(raw.productIds, 'productIds', MAX_PRODUCT_TARGETS, issues);
  const sellerIds = idList<'Seller'>(raw.sellerIds, 'sellerIds', MAX_SELLER_TARGETS, issues);
  const zones: string[] = [];
  if (raw.zones !== undefined && raw.zones !== null) {
    if (!Array.isArray(raw.zones) || raw.zones.length > MAX_ZONE_TARGETS) {
      issues.push({ path: 'zones', code: Array.isArray(raw.zones) ? 'too-many' : 'type' });
    } else {
      for (const [index, zone] of raw.zones.entries()) {
        if (typeof zone !== 'string' || !ZONE_PATTERN.test(zone)) {
          issues.push({ path: `zones.${index}`, code: 'value' });
        } else if (!zones.includes(zone)) {
          zones.push(zone);
        }
      }
    }
  }

  if (
    issues.length > 0 ||
    type === null ||
    name === null ||
    funding === null ||
    startsAt === null ||
    reward === null
  ) {
    return err(issues);
  }
  return ok({
    type,
    name,
    funding,
    platformSplitBps: platformSplit,
    combinable,
    code,
    startsAt,
    endsAt,
    testMode,
    specialCampaign,
    reward,
    capMinor,
    maxPerOrderMinor,
    maxTotalUses,
    maxUsesPerCustomer,
    budgetMinor,
    minSpendMinor,
    productIds,
    sellerIds,
    zones,
    tiers,
    buyQty,
    getQty,
    groupQty,
    bundleItems,
    maxRepeatsPerOrder,
    flashUnitLimit,
    flashTimeZone,
  });
}

/**
 * The reward the Market's percent limits are read against. A percent off a unit is that percent;
 * "buy X get Y" at a percent is the share of a full group it takes off (buy 2 get 1 free is
 * 3333 bps), so the limits mean the same for every type. A fixed amount, a group price and an
 * amount off a set cannot be compared with a price here: the calculation holds them to the same
 * limits per line instead.
 */
export function approvalRewardOf(
  draft: Pick<PromotionDraft, 'type' | 'reward' | 'buyQty' | 'getQty'>,
): Reward {
  if (
    draft.type === 'BUY_X_GET_Y' &&
    draft.reward.kind === 'PERCENT' &&
    draft.buyQty !== null &&
    draft.getQty !== null
  ) {
    return {
      kind: 'PERCENT',
      bps: Math.floor((draft.getQty * draft.reward.bps) / (draft.buyQty + draft.getQty)),
    };
  }
  return draft.reward;
}

/** The fields each type needs, allows and forbids; the numbers of the type are checked with them. */
function checkTypeFields(
  draft: PromotionDraft,
  bad: (path: string, code: string) => unknown,
): void {
  const only = (present: boolean, type: CreatableType | readonly CreatableType[], path: string) => {
    const types = typeof type === 'string' ? [type] : type;
    if (present && !types.includes(draft.type)) bad(path, 'not-allowed');
  };
  only(draft.tiers.length > 0, 'TIERED_CART', 'tiers');
  only(draft.buyQty !== null, 'BUY_X_GET_Y', 'buyQty');
  only(draft.getQty !== null, 'BUY_X_GET_Y', 'getQty');
  only(draft.groupQty !== null, 'MULTI_BUY', 'groupQty');
  only(draft.bundleItems.length > 0, 'BUNDLE', 'bundleItems');
  only(draft.flashUnitLimit !== null, 'FLASH_SALE', 'flash');
  only(draft.flashTimeZone !== null, 'FLASH_SALE', 'flash');
  only(
    draft.maxRepeatsPerOrder !== null,
    ['BUY_X_GET_Y', 'MULTI_BUY', 'BUNDLE'],
    'maxRepeatsPerOrder',
  );

  switch (draft.type) {
    case 'TIERED_CART': {
      if (draft.tiers.length === 0) bad('tiers', 'required');
      if (draft.minSpendMinor !== null) bad('minSpendMinor', 'not-allowed');
      const kind = draft.tiers[0]?.reward.kind;
      for (const [index, tier] of draft.tiers.entries()) {
        const before = draft.tiers[index - 1];
        if (tier.reward.kind !== kind) bad(`tiers.${index}.reward`, 'mixed-kinds');
        if (before !== undefined) {
          if (tier.thresholdMinor <= before.thresholdMinor)
            bad(`tiers.${index}.thresholdMinor`, 'not-increasing');
          const more =
            tier.reward.kind === 'PERCENT' && before.reward.kind === 'PERCENT'
              ? tier.reward.bps > before.reward.bps
              : tier.reward.kind === 'FIXED' && before.reward.kind === 'FIXED'
                ? tier.reward.amount > before.reward.amount
                : true;
          if (!more) bad(`tiers.${index}.reward`, 'not-increasing');
        }
        // A fixed amount off the goods must be less than the goods it starts at.
        if (tier.reward.kind === 'FIXED' && tier.reward.amount >= tier.thresholdMinor) {
          bad(`tiers.${index}.reward.amountMinor`, 'exceeds-threshold');
        }
      }
      break;
    }
    case 'BUY_X_GET_Y':
      if (draft.buyQty === null) bad('buyQty', 'required');
      if (draft.getQty === null) bad('getQty', 'required');
      break;
    case 'MULTI_BUY':
      if (draft.groupQty === null) bad('groupQty', 'required');
      else if (draft.groupQty < 2) bad('groupQty', 'value');
      break;
    case 'BUNDLE':
      if (draft.bundleItems.length < 2) bad('bundleItems', 'too-few');
      if (draft.reward.kind !== 'FIXED') bad('reward.kind', 'value');
      break;
    case 'FLASH_SALE':
      if (draft.flashUnitLimit === null) bad('flash.unitLimit', 'required');
      if (draft.flashTimeZone === null) bad('flash.timeZone', 'required');
      // A real end, so a countdown is never faked.
      if (draft.endsAt === null) bad('endsAt', 'required');
      break;
    default:
      break;
  }
}

/**
 * The business rules of a draft, for the owner who makes it (at create and at edit):
 * - a seller promotes its own products with its own money, at most the Market's seller maximum;
 * - a platform promotion is platform-funded (or a co-funded campaign with a split), has a total
 *   budget, and, until the tax ruling is confirmed in the Market, is test mode only;
 * - a code belongs to a code promotion, and only to it;
 * - shipping is platform-funded and has a spend threshold;
 * - only an admin flags a special campaign, and only on a platform-funded or co-funded promotion.
 */
export function checkDraft(
  draft: PromotionDraft,
  owner: Owner,
  rules: PromotionRules,
): readonly FieldIssue[] {
  const issues: FieldIssue[] = [];
  const bad = (path: string, code: string) => issues.push({ path, code });
  const seller = owner.kind === 'seller';

  if (draft.endsAt !== null && Temporal.Instant.compare(draft.endsAt, draft.startsAt) <= 0) {
    bad('endsAt', 'before-start');
  }
  if (draft.type === 'CART_CODE' ? draft.code === null : draft.code !== null) {
    bad('code', draft.type === 'CART_CODE' ? 'required' : 'not-allowed');
  }

  // Who may make which type, and with whose money.
  if (seller) {
    if (ADMIN_ONLY_TYPES.includes(draft.type)) bad('type', 'not-allowed');
    if (draft.funding !== 'SELLER') bad('funding', 'seller-money-only');
    if (draft.specialCampaign) bad('specialCampaign', 'not-allowed');
    if (draft.testMode) bad('testMode', 'not-allowed');
    if (draft.sellerIds.length > 0) bad('sellerIds', 'not-allowed');
  } else {
    if (SELLER_ONLY_TYPES.includes(draft.type)) bad('type', 'not-allowed');
    if (draft.type === 'CO_FUNDED_CAMPAIGN') {
      if (draft.funding !== 'CO_FUNDED') bad('funding', 'value');
    } else if (draft.funding !== 'PLATFORM') {
      bad('funding', 'platform-money-only');
    }
    if (draft.budgetMinor === null) bad('budgetMinor', 'required');
  }
  if (NEEDS_PRODUCTS.includes(draft.type) && draft.productIds.length === 0) {
    bad('productIds', 'required');
  }
  checkTypeFields(draft, bad);
  if (draft.type === 'FREE_SHIPPING' && draft.minSpendMinor === null)
    bad('minSpendMinor', 'required');
  if (draft.type !== 'FREE_SHIPPING' && draft.zones.length > 0) bad('zones', 'not-allowed');
  if (draft.funding === 'CO_FUNDED') {
    if (draft.platformSplitBps === null) bad('platformSplitBps', 'required');
  } else if (draft.platformSplitBps !== null) {
    bad('platformSplitBps', 'not-allowed');
  }
  if (draft.specialCampaign && draft.funding === 'SELLER') bad('specialCampaign', 'not-allowed');

  // The seller maximum: a percent reward is checked here; a fixed amount cannot be compared with a
  // price here, so the calculation holds it to the same maximum per line.
  const headline = approvalRewardOf(draft);
  if (
    draft.funding === 'SELLER' &&
    headline.kind === 'PERCENT' &&
    headline.bps > rules.sellerMaxDiscountBps
  ) {
    bad(draft.type === 'BUY_X_GET_Y' ? 'getQty' : 'reward.bps', 'exceeds-seller-maximum');
  }
  // A co-funded percent reward: the seller pays what the platform does not, so the seller's share
  // of the discount (reward x (10000 - split)) must stay within the seller maximum too. A fixed
  // amount is held to it per line by the calculation.
  if (
    draft.funding === 'CO_FUNDED' &&
    draft.platformSplitBps !== null &&
    draft.reward.kind === 'PERCENT' &&
    draft.reward.bps * (MAX_BPS - draft.platformSplitBps) > rules.sellerMaxDiscountBps * MAX_BPS
  ) {
    bad('reward.bps', 'exceeds-seller-maximum');
  }
  if (draft.reward.kind === 'FIXED' && draft.capMinor !== null) bad('capMinor', 'not-allowed');

  // Platform money in a Market whose tax ruling is not confirmed stays in test mode.
  if (draft.funding !== 'SELLER' && !rules.gstRulingConfirmed && !draft.testMode) {
    bad('testMode', 'required');
  }
  return issues;
}

/**
 * Whether a promotion counts against the Market's maximum of promotions per seller: waiting for
 * approval or live, and not ended. A paused, rejected or ended promotion does not, but it must fit
 * under the maximum when it comes back (resume, or an edit that moves its end).
 */
export function countsTowardSellerCap(
  promotion: Pick<PromotionRecord, 'status' | 'endsAt'>,
  now: Temporal.Instant,
): boolean {
  return (
    (promotion.status === 'ACTIVE' || promotion.status === 'PENDING_APPROVAL') &&
    (promotion.endsAt === null || Temporal.Instant.compare(promotion.endsAt, now) > 0)
  );
}

/** What the approval rule needs to know about the seller and the discount. */
export interface ApprovalFacts {
  /** Whole days the seller has been active; null when unknown (fail closed: approval needed). */
  readonly sellerActiveDays: number | null;
  readonly reward: Reward;
}

/** Why a seller promotion waits for approval before it goes live; null when it goes live at once. */
export type ApprovalReason = 'NEW_SELLER' | 'HIGH_DISCOUNT';

/**
 * A seller's promotion goes live without prior approval, except for a seller active for fewer
 * days than the Market's `newSellerDays` (or whose age is unknown) and a percent discount above
 * the Market's `priorApprovalDiscountBps`. A fixed reward cannot be compared with a price here;
 * the calculation holds it to that same share per line until an admin has approved.
 */
export function approvalReason(facts: ApprovalFacts, rules: PromotionRules): ApprovalReason | null {
  if (facts.sellerActiveDays === null || facts.sellerActiveDays < rules.newSellerDays) {
    return 'NEW_SELLER';
  }
  if (facts.reward.kind === 'PERCENT' && facts.reward.bps > rules.priorApprovalDiscountBps) {
    return 'HIGH_DISCOUNT';
  }
  return null;
}

/**
 * A fresh two-step code is needed to commit platform money above the Market's threshold (the
 * platform's exposure of the budget, when it is new or has grown), and to flag a special campaign
 * (the commission cap is waived for it).
 */
export function needsFreshSecondFactor(
  before: Pick<
    PromotionDraft,
    'funding' | 'platformSplitBps' | 'budgetMinor' | 'specialCampaign' | 'testMode'
  > | null,
  after: Pick<
    PromotionDraft,
    'funding' | 'platformSplitBps' | 'budgetMinor' | 'specialCampaign' | 'testMode'
  >,
  rules: PromotionRules,
): boolean {
  if (after.specialCampaign && !(before?.specialCampaign ?? false)) return true;
  const now = platformExposure(after.funding, after.platformSplitBps, after.budgetMinor);
  // A promotion that leaves test mode puts its whole budget at stake: it counts as new money.
  const was =
    before === null || (before.testMode && !after.testMode)
      ? 0n
      : platformExposure(before.funding, before.platformSplitBps, before.budgetMinor);
  return now > rules.platformBudgetStepUpMinor && now > was;
}
