import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import { CARRIER_METHODS, type CarrierMethod } from './booking-service';
import { DEFAULT_FLEET_ORDER, FLEET_CODES, OWN_FLEET, isFleetCode, type FleetCode } from './fleet';

// Fleet-selection models (delivery models, package 3). An admin defines named models and picks
// the active one per Market and per delivery method; the router ranks the fleets that can carry a
// seller order by that model. Three kinds exist:
//   cheapest        the lowest quote wins;
//   weighted        score = weights over price, ETA and reliability (all set by the admin);
//   fixed_priority  an ordered list of fleets; a fleet not on the list is not used.
// Ties always go to the platform's own fleet (Mondapac Drive), then to the default order.
// Reliability is an admin-set score (0 to 100) per fleet and Market for now; a score computed
// from delivery history replaces it later without changing the model.

export const MODEL_KINDS = ['cheapest', 'weighted', 'fixed_priority'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export interface Weights {
  readonly price: number;
  readonly eta: number;
  readonly reliability: number;
}

export type SelectionRule =
  | { readonly kind: 'cheapest' }
  | { readonly kind: 'weighted'; readonly weights: Weights }
  | { readonly kind: 'fixed_priority'; readonly order: readonly FleetCode[] };

export interface FleetSelectionModel {
  readonly id: Id<'FleetSelectionModel'>;
  readonly name: string;
  readonly rule: SelectionRule;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** The rule used for a (Market, method) with no active model: own fleet first, the rest by default order. */
export const DEFAULT_RULE: SelectionRule = {
  kind: 'fixed_priority',
  order: DEFAULT_FLEET_ORDER,
};

/** Reliability of a fleet nobody scored: neutral, so it neither wins nor loses on that alone. */
export const DEFAULT_RELIABILITY = 50;

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()/_-]{0,59}$/u;

export type Field = { readonly path: string; readonly code: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A model name: 1 to 60 letters, digits, spaces and light punctuation, trimmed and NFC. */
export function parseModelName(
  input: unknown,
): { ok: true; name: string } | { ok: false; field: Field } {
  const name = typeof input === 'string' ? input.normalize('NFC').trim() : '';
  return NAME.test(name)
    ? { ok: true, name }
    : { ok: false, field: { path: 'name', code: 'format' } };
}

/** The rule of a request body, checked: unknown kinds and fields are refused. */
export function parseSelectionRule(
  input: unknown,
): { ok: true; rule: SelectionRule } | { ok: false; fields: readonly Field[] } {
  if (!isObject(input)) return { ok: false, fields: [{ path: 'rule', code: 'format' }] };
  const kind = MODEL_KINDS.find((candidate) => candidate === input.kind);
  if (kind === undefined) return { ok: false, fields: [{ path: 'rule.kind', code: 'value' }] };
  const allowed =
    kind === 'cheapest' ? ['kind'] : kind === 'weighted' ? ['kind', 'weights'] : ['kind', 'order'];
  const extra = Object.keys(input).find((key) => !allowed.includes(key));
  if (extra !== undefined)
    return { ok: false, fields: [{ path: `rule.${extra}`, code: 'unknown-field' }] };
  if (kind === 'cheapest') return { ok: true, rule: { kind } };
  if (kind === 'weighted') {
    const weights = input.weights;
    if (!isObject(weights))
      return { ok: false, fields: [{ path: 'rule.weights', code: 'format' }] };
    const fields: Field[] = [];
    const read = (key: keyof Weights): number => {
      const value = weights[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
        fields.push({ path: `rule.weights.${key}`, code: 'range' });
        return 0;
      }
      return value;
    };
    const parsed: Weights = {
      price: read('price'),
      eta: read('eta'),
      reliability: read('reliability'),
    };
    const extraKey = Object.keys(weights).find(
      (key) => !['price', 'eta', 'reliability'].includes(key),
    );
    if (extraKey !== undefined)
      fields.push({ path: `rule.weights.${extraKey}`, code: 'unknown-field' });
    if (fields.length === 0 && parsed.price + parsed.eta + parsed.reliability === 0) {
      fields.push({ path: 'rule.weights', code: 'zero-sum' });
    }
    return fields.length > 0
      ? { ok: false, fields }
      : { ok: true, rule: { kind, weights: parsed } };
  }
  const order = input.order;
  if (!Array.isArray(order) || order.length === 0 || order.length > FLEET_CODES.length) {
    return { ok: false, fields: [{ path: 'rule.order', code: 'range' }] };
  }
  const fleets: FleetCode[] = [];
  for (const entry of order as unknown[]) {
    if (!isFleetCode(entry)) return { ok: false, fields: [{ path: 'rule.order', code: 'value' }] };
    if (fleets.includes(entry))
      return { ok: false, fields: [{ path: 'rule.order', code: 'duplicate' }] };
    fleets.push(entry);
  }
  return { ok: true, rule: { kind, order: fleets } };
}

export function parseMethod(input: unknown): CarrierMethod | null {
  return CARRIER_METHODS.find((candidate) => candidate === input) ?? null;
}

export function parseReliability(input: unknown): number | null {
  return typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= 100
    ? input
    : null;
}

/** What the router knows of a fleet that can carry the order. */
export interface Candidate {
  readonly fleet: FleetCode;
  /** The fleet's quote for this trip; null when it gave none (down, refused, other currency). */
  readonly quote: {
    readonly price: Money;
    readonly etaMinutes: number | null;
  } | null;
  /** 0 to 100. */
  readonly reliability: number;
}

/** Whether ranking by this rule needs live quotes (a fixed priority list does not). */
export const needsQuotes = (rule: SelectionRule): boolean => rule.kind !== 'fixed_priority';

/** Own fleet first, then the default order: the last word in every tie. */
const tieOrder = (fleet: FleetCode): number =>
  fleet === OWN_FLEET ? -1 : DEFAULT_FLEET_ORDER.indexOf(fleet);

const byTie = (a: Candidate, b: Candidate): number => tieOrder(a.fleet) - tieOrder(b.fleet);

const SCALE = 1000n;

/**
 * The fleets in the order they are tried. Pure and deterministic: no clock, no randomness.
 * Fleets without a usable quote come after every quoted one (in tie order) under `cheapest` and
 * `weighted`; a quote in another currency than the cheapest-known one is treated as no quote.
 */
export function rankFleets(rule: SelectionRule, candidates: readonly Candidate[]): FleetCode[] {
  if (rule.kind === 'fixed_priority') {
    return rule.order.filter((fleet) => candidates.some((c) => c.fleet === fleet));
  }
  const currency = [...candidates]
    .filter((c) => c.quote !== null)
    .sort(byTie)
    .at(0)?.quote?.price.currency;
  const quoted = candidates.filter((c) => c.quote !== null && c.quote.price.currency === currency);
  const unquoted = candidates.filter((c) => !quoted.includes(c)).sort(byTie);
  const rest = unquoted.map((c) => c.fleet);
  if (quoted.length === 0) return rest;

  if (rule.kind === 'cheapest') {
    const sorted = [...quoted].sort((a, b) => {
      const difference = a.quote!.price.amount - b.quote!.price.amount;
      return difference !== 0n ? (difference < 0n ? -1 : 1) : byTie(a, b);
    });
    return [...sorted.map((c) => c.fleet), ...rest];
  }

  const prices = quoted.map((c) => c.quote!.price.amount);
  const cheapest = prices.reduce((low, price) => (price < low ? price : low));
  const etas = quoted
    .map((c) => c.quote!.etaMinutes)
    .filter((eta): eta is number => eta !== null)
    .map((eta) => Math.max(eta, 1));
  const fastest = etas.length === 0 ? null : Math.min(...etas);
  const { weights } = rule;
  const score = (c: Candidate): bigint => {
    const price = c.quote!.price.amount;
    const priceScore = price === 0n ? SCALE : (cheapest * SCALE) / price;
    const eta = c.quote!.etaMinutes;
    const etaScore =
      fastest === null
        ? SCALE
        : eta === null
          ? 0n
          : (BigInt(fastest) * SCALE) / BigInt(Math.max(eta, 1));
    const reliabilityScore = BigInt(c.reliability) * 10n;
    return (
      BigInt(weights.price) * priceScore +
      BigInt(weights.eta) * etaScore +
      BigInt(weights.reliability) * reliabilityScore
    );
  };
  const scored = quoted.map((c) => ({ c, s: score(c) }));
  scored.sort((a, b) => (a.s !== b.s ? (a.s > b.s ? -1 : 1) : byTie(a.c, b.c)));
  return [...scored.map(({ c }) => c.fleet), ...rest];
}
