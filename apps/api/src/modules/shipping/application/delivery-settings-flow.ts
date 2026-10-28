import { err, ok, parseId, parseMoney, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { auditCode, DeliverySettingsChanged, SellerDeliveryMethodsSet } from '../domain/audit';
import { applyDeliveryMargin, type PricedDelivery } from '../domain/delivery-margin';
import {
  DELIVERY_METHODS,
  isDeliveryMethod,
  type DeliveryMethod,
} from '../domain/delivery-methods';
import {
  checkChoice,
  evaluateMethods,
  formatCutoff,
  parseDeliverySettings,
  parseMethodSet,
  type ChoiceRefusal,
  type DeliverySettings,
  type SellerDeliveryAvailability,
} from '../domain/delivery-settings';
import { sellerIdsOf } from './flat-fee-flow';
import type { ActorId } from './ports/fleet-selection.repository';
import type { ShippingDependencies } from './shipping-dependencies';

// The delivery settings (delivery models, package 4): an admin switches methods on or off for the
// Market, sets the same-day cut-off, the scheduled days and window and the margin, and decides
// which methods each seller supports. Checkout and the basket read what a seller offers now.
// Authorization is the use case's access declaration; the admin functions re-check that the
// actor is an admin account (defence in depth). Every change is audited in the same unit.

type Field = { readonly path: string; readonly code: string };

export type DeliverySettingsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly Field[] }
  | { readonly code: 'shipping.seller-not-found' }
  /** The settings changed since the admin read them: read again and retry. */
  | { readonly code: 'shipping.delivery-settings-conflict' }
  | { readonly code: 'shipping.unavailable' };

export interface DeliverySettingsView {
  readonly settings: DeliverySettings;
  /** The Market currency, in which a fixed margin and the rounding steps are counted. */
  readonly currency: string;
  /** The Market's own zone: the fallback of a seller without one. */
  readonly marketZone: string;
}

export interface SellerDeliveryMethodsView {
  readonly sellerId: Id<'Seller'>;
  /** What the seller supports, whatever the Market has on. */
  readonly supported: readonly DeliveryMethod[];
  /** What the Market has on, so a screen can show a method as "off for the platform". */
  readonly platformEnabled: Readonly<Record<DeliveryMethod, boolean>>;
}

const adminOf = (context: CallContext): ActorId | null => {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin' ? actor.accountId : null;
};

const sellerIdOf = (value: unknown): Id<'Seller'> | null => {
  const parsed = typeof value === 'string' ? parseId<'Seller'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

type AuditMethod = 'pickup' | 'instant' | 'same-day' | 'scheduled';
const auditMethods = (methods: readonly DeliveryMethod[]): AuditMethod[] =>
  methods.map((method) => auditCode<AuditMethod>(method));

/** What an audit row records of the settings. */
function settingsShape(settings: DeliverySettings) {
  const { margin } = settings;
  return {
    enabled: auditMethods(DELIVERY_METHODS.filter((method) => settings.enabled[method])),
    sameDayCutoffMinutes: settings.sameDayCutoffMinutes,
    scheduledDaysAhead: settings.scheduledDaysAhead,
    scheduledWindowMinutes: settings.scheduledWindowMinutes,
    marginKind: margin.kind,
    marginValue:
      margin.kind === 'percent'
        ? margin.basisPoints
        : margin.kind === 'fixed'
          ? margin.amountMinor
          : 0,
    roundingStepMinor: settings.roundingStepMinor,
    version: settings.version,
  };
}

const viewOf = (
  deps: ShippingDependencies,
  context: CallContext,
  settings: DeliverySettings,
): DeliverySettingsView => ({
  settings,
  currency: deps.policy.currency(context.market),
  marketZone: deps.policy.timeZone(context.market),
});

/** `view-delivery-settings`: the Market's settings (the defaults while nothing was saved). */
export function viewDeliverySettings(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<Result<DeliverySettingsView, DeliverySettingsFailure>> {
  if (adminOf(context) === null) return Promise.resolve(err({ code: 'access.denied' }));
  return deps.unitOfWork.run<DeliverySettingsView, DeliverySettingsFailure>(
    context.market,
    async () => ok(viewOf(deps, context, await deps.deliverySettings.settings(context.market))),
    { readOnly: true },
  );
}

/**
 * `set-delivery-settings`: saves the whole set of settings; `expectedVersion` (0 before the
 * first save) guards a stale page, and a stale one is `shipping.delivery-settings-conflict`.
 */
export async function setDeliverySettings(
  deps: ShippingDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<DeliverySettingsView, DeliverySettingsFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const version =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).expectedVersion
      : undefined;
  const parsed = parseDeliverySettings(input);
  const fields: Field[] = [
    ...(parsed.ok ? [] : parsed.fields),
    ...(typeof version === 'number' && Number.isInteger(version) && version >= 0
      ? []
      : [{ path: 'expectedVersion', code: 'range' }]),
  ];
  if (!parsed.ok || typeof version !== 'number' || fields.length > 0) {
    return err({ code: 'validation.failed', fields });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<DeliverySettingsView, DeliverySettingsFailure>(
    context.market,
    async () => {
      const before = await deps.deliverySettings.settings(context.market);
      if (before.version !== version) return err({ code: 'shipping.delivery-settings-conflict' });
      const saved = await deps.deliverySettings.saveSettings(
        context.market,
        parsed.value,
        version,
        admin,
        now,
      );
      if (saved === 'conflict') return err({ code: 'shipping.delivery-settings-conflict' });
      await deps.audit.record(
        context,
        DeliverySettingsChanged.entry('market', {
          before: settingsShape(before),
          after: settingsShape(saved),
        }),
      );
      return ok(viewOf(deps, context, saved));
    },
  );
}

async function readSellerMethods(
  deps: ShippingDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<Result<SellerDeliveryMethodsView, DeliverySettingsFailure>> {
  return deps.unitOfWork.run<SellerDeliveryMethodsView, DeliverySettingsFailure>(
    context.market,
    async () => {
      const [settings, unsupported] = await Promise.all([
        deps.deliverySettings.settings(context.market),
        deps.deliverySettings.unsupportedOf(context.market, [sellerId]),
      ]);
      const taken = new Set(unsupported.get(sellerId) ?? []);
      return ok({
        sellerId,
        supported: DELIVERY_METHODS.filter((method) => !taken.has(method)),
        platformEnabled: settings.enabled,
      });
    },
    { readOnly: true },
  );
}

/** `view-seller-delivery-methods`: what a seller supports (every method until an admin says otherwise). */
export async function viewSellerDeliveryMethods(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown },
): Promise<Result<SellerDeliveryMethodsView, DeliverySettingsFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return err({ code: 'shipping.unavailable' });
  if (!known) return err({ code: 'shipping.seller-not-found' });
  return readSellerMethods(deps, context, sellerId);
}

/** `set-seller-delivery-methods`: the methods the seller supports; the rest are taken away. */
export async function setSellerDeliveryMethods(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown; readonly supported: unknown },
): Promise<Result<SellerDeliveryMethodsView, DeliverySettingsFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  const supported = parseMethodSet(input?.supported);
  const fields: Field[] = [
    ...(sellerId === null ? [{ path: 'sellerId', code: 'format' }] : []),
    ...(supported === null ? [{ path: 'supported', code: 'value' }] : []),
  ];
  if (sellerId === null || supported === null) return err({ code: 'validation.failed', fields });
  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return err({ code: 'shipping.unavailable' });
  if (!known) return err({ code: 'shipping.seller-not-found' });
  const now = deps.clock.now();
  const unsupported = DELIVERY_METHODS.filter((method) => !supported.includes(method));
  return deps.unitOfWork.run<SellerDeliveryMethodsView, DeliverySettingsFailure>(
    context.market,
    async () => {
      const before =
        (await deps.deliverySettings.unsupportedOf(context.market, [sellerId])).get(sellerId) ?? [];
      await deps.deliverySettings.setUnsupported(context.market, sellerId, unsupported, admin, now);
      await deps.audit.record(
        context,
        SellerDeliveryMethodsSet.entry(sellerId, {
          before: { unsupported: auditMethods(before) },
          after: { unsupported: auditMethods(unsupported) },
        }),
      );
      const settings = await deps.deliverySettings.settings(context.market);
      return ok({ sellerId, supported, platformEnabled: settings.enabled });
    },
  );
}

// ---------------------------------------------------------------------------------------------
// What a seller offers now (checkout, and the basket of package 5)

type OfferFailure = { readonly code: 'shipping.unavailable' };

/** A zone the polyfill can use, else null (a stored zone is checked at write; this is defence in depth). */
const usableZone = (zone: string | undefined, now: Temporal.Instant): string | null => {
  if (zone === undefined) return null;
  try {
    now.toZonedDateTimeISO(zone);
    return zone;
  } catch {
    return null;
  }
};

interface OfferFacts {
  readonly settings: DeliverySettings;
  readonly unsupported: ReadonlyMap<Id<'Seller'>, readonly DeliveryMethod[]>;
  readonly postcodes: ReadonlyMap<Id<'Seller'>, string>;
  readonly zones: ReadonlyMap<Id<'Seller'>, string>;
}

/** Reads the settings, the sellers' methods, their pickup addresses and zones; any failed read fails the whole. */
async function readOfferFacts(
  deps: ShippingDependencies,
  context: CallContext,
  sellerIds: readonly Id<'Seller'>[],
): Promise<Result<OfferFacts, OfferFailure>> {
  let stored: Pick<OfferFacts, 'settings' | 'unsupported'>;
  try {
    const read = await deps.unitOfWork.run<
      Pick<OfferFacts, 'settings' | 'unsupported'>,
      OfferFailure
    >(
      context.market,
      async () =>
        ok({
          settings: await deps.deliverySettings.settings(context.market),
          unsupported: await deps.deliverySettings.unsupportedOf(context.market, sellerIds),
        }),
      { readOnly: true },
    );
    if (!read.ok) return read;
    stored = read.value;
  } catch {
    return err({ code: 'shipping.unavailable' });
  }
  const [postcodes, zones] = await Promise.all([
    deps.pickups.postcodesOf(context, sellerIds),
    deps.pickups.zonesOf(context, sellerIds),
  ]);
  if (!postcodes.ok || !zones.ok) return err({ code: 'shipping.unavailable' });
  return ok({ ...stored, postcodes: postcodes.value, zones: zones.value });
}

function factsOf(
  deps: ShippingDependencies,
  context: CallContext,
  offer: OfferFacts,
  sellerId: Id<'Seller'>,
  now: Temporal.Instant,
) {
  const zone =
    usableZone(offer.zones.get(sellerId), now) ??
    usableZone(deps.policy.timeZone(context.market), now) ??
    'UTC';
  return {
    zone,
    facts: {
      settings: offer.settings,
      sellerUnsupported: new Set(offer.unsupported.get(sellerId) ?? []),
      hasPickupAddress: offer.postcodes.has(sellerId),
      now,
      zone,
    },
  };
}

/**
 * `delivery-availability`: for each asked seller (at most 100), the four delivery methods now
 * with the reason for every one that is unavailable. Platform off, then seller does not support
 * it, then the rule of the method (pickup address; same-day cut-off in the seller's zone). The
 * answer is the same for every caller. A failed read is `shipping.unavailable`, never "all open".
 */
export async function deliveryAvailability(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerIds: unknown },
): Promise<Result<ReadonlyMap<Id<'Seller'>, SellerDeliveryAvailability>, DeliverySettingsFailure>> {
  const parsed = sellerIdsOf(input?.sellerIds);
  if (!parsed.ok) return parsed;
  if (parsed.value.length === 0) return ok(new Map());
  const offer = await readOfferFacts(deps, context, parsed.value);
  if (!offer.ok) return offer;
  const now = deps.clock.now();
  const answer = new Map<Id<'Seller'>, SellerDeliveryAvailability>();
  for (const sellerId of parsed.value) {
    const { zone, facts } = factsOf(deps, context, offer.value, sellerId, now);
    answer.set(sellerId, {
      sellerId,
      zone,
      methods: evaluateMethods(facts),
      sameDayCutoff: formatCutoff(offer.value.settings.sameDayCutoffMinutes),
      scheduledDaysAhead: offer.value.settings.scheduledDaysAhead,
      scheduledWindowMinutes: offer.value.settings.scheduledWindowMinutes,
    });
  }
  return ok(answer);
}

export interface DeliveryChoiceVerdict {
  readonly allowed: boolean;
  /** Why not: a method reason or a window reason; null when allowed. */
  readonly reason: ChoiceRefusal | null;
}

const windowOf = (
  value: unknown,
): { start: Temporal.Instant; end: Temporal.Instant } | null | 'bad' => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'bad';
  const { start, end } = value as Record<string, unknown>;
  try {
    if (typeof start !== 'string' || typeof end !== 'string') return 'bad';
    return { start: Temporal.Instant.from(start), end: Temporal.Instant.from(end) };
  } catch {
    return 'bad';
  }
};

/**
 * `delivery-choice`: whether one seller order may be delivered the way the buyer chose: the
 * method is available now for the seller and, for scheduled, the window is one the Market offers.
 * The answer is the same for every caller. A failed read is `shipping.unavailable`.
 */
export async function deliveryChoice(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown; readonly method: unknown; readonly window: unknown },
): Promise<Result<DeliveryChoiceVerdict, DeliverySettingsFailure>> {
  const sellerId = sellerIdOf(input?.sellerId);
  const window = windowOf(input?.window);
  const fields: Field[] = [
    ...(sellerId === null ? [{ path: 'sellerId', code: 'format' }] : []),
    ...(isDeliveryMethod(input?.method) ? [] : [{ path: 'method', code: 'value' }]),
    ...(window === 'bad' ? [{ path: 'window', code: 'format' }] : []),
  ];
  if (sellerId === null || !isDeliveryMethod(input.method) || window === 'bad') {
    return err({ code: 'validation.failed', fields });
  }
  const offer = await readOfferFacts(deps, context, [sellerId]);
  if (!offer.ok) return offer;
  const { facts } = factsOf(deps, context, offer.value, sellerId, deps.clock.now());
  const reason = checkChoice(facts, { method: input.method, window });
  return ok({ allowed: reason === null, reason });
}

/**
 * `price-delivery`: what the buyer pays for a delivery whose fleet quote is `quote`: the quote
 * plus the Market's margin, rounded up to its step (`applyDeliveryMargin`). The quote must be in
 * the Market currency and not negative. Nothing is stored or audited.
 */
export async function priceDelivery(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly quote: unknown },
): Promise<Result<PricedDelivery, DeliverySettingsFailure>> {
  const currency = deps.policy.currency(context.market);
  const quote = parseMoney(
    (input?.quote as { amount?: unknown } | null | undefined)?.amount,
    (input?.quote as { currency?: unknown } | null | undefined)?.currency,
  );
  if (!quote.ok || quote.value.currency !== currency || quote.value.amount < 0n) {
    return err({ code: 'validation.failed', fields: [{ path: 'quote', code: 'value' }] });
  }
  try {
    const settings = await deps.unitOfWork.run<DeliverySettings, DeliverySettingsFailure>(
      context.market,
      async () => ok(await deps.deliverySettings.settings(context.market)),
      { readOnly: true },
    );
    if (!settings.ok) return settings;
    return ok(applyDeliveryMargin(quote.value, settings.value));
  } catch {
    return err({ code: 'shipping.unavailable' });
  }
}
