import type { CallContext } from '@mondapac/shared-kernel';
import type { ActorId } from './ports/fleet-selection.repository';
import type { ChangeValues, RecordedRequest, Risk } from '../../system-requests';
import { DELIVERY_METHODS } from '../domain/delivery-methods';
import type { DeliveryMethod } from '../domain/delivery-methods';
import type { DeliverySettingsInput } from '../domain/delivery-settings';
import { formatCutoff } from '../domain/delivery-settings';
import type { ShippingDependencies } from './shipping-dependencies';

// Admin Inbox › System requests, area delivery: an admin's delivery changes go live at once and
// are reviewed after (owner decision of 15 Nov 2026). Only changes that can be put back are
// reviewed: the Market's delivery settings, the methods a seller supports, the active fleet
// models and reliability scores, and the edit of a model. A rejected or withdrawn change is
// restored by the reverters in shipping-reverters.ts. Creating a model is not reviewed.

/** The review area of shipping's changes. */
export const DELIVERY_REVIEW_AREA = 'delivery';
/** The Market's delivery settings; subject `delivery-settings`. */
export const DELIVERY_SETTINGS_SUBJECT_KIND = 'shipping.delivery-settings';
export const DELIVERY_SETTINGS_SUBJECT_REF = 'delivery-settings';
/** The methods a seller does not support; subject = the seller id; values `{unsupported}`. */
export const SELLER_METHODS_SUBJECT_KIND = 'shipping.seller-delivery-methods';
/** The fleet-selection page: the active model per method and the reliability scores. */
export const FLEET_SELECTION_SUBJECT_KIND = 'shipping.fleet-selection';
export const FLEET_SELECTION_SUBJECT_REF = 'fleet-selection';
/** The name and rule of one fleet-selection model; subject = the model id. */
export const FLEET_MODEL_SUBJECT_KIND = 'shipping.fleet-selection-model';

/** Whether a change of delivery is reviewed in the Market (the page then asks for a note). */
export interface ShippingReview {
  readonly reviewed: boolean;
  readonly risk: Risk;
}

/** The review request a change opened (null when none), as an answer carries it. */
export type ShippingRequestRef = Pick<RecordedRequest, 'id' | 'number'> | null;

export const requestRef = (request: RecordedRequest | null): ShippingRequestRef =>
  request === null ? null : { id: request.id, number: request.number };

/**
 * The review policy of area delivery, for the page (the area's default on a failure). It opens a
 * read-only unit of its own, so call it outside any unit.
 */
export async function deliveryReview(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<ShippingReview> {
  const policy = await deps.review.areaPolicy(context, DELIVERY_REVIEW_AREA);
  return { reviewed: policy.enabled, risk: policy.risk };
}

/** The settings as the values of a request (no version: it is not a setting). */
export function settingsValues(settings: DeliverySettingsInput): ChangeValues {
  const { margin } = settings;
  return {
    enabled: Object.fromEntries(
      DELIVERY_METHODS.map((method) => [method, settings.enabled[method]]),
    ),
    sameDayCutoffMinutes: settings.sameDayCutoffMinutes,
    scheduledDaysAhead: settings.scheduledDaysAhead,
    scheduledWindowMinutes: settings.scheduledWindowMinutes,
    readyPrepMinutes: settings.readyPrepMinutes,
    margin:
      margin.kind === 'percent'
        ? { kind: margin.kind, basisPoints: margin.basisPoints }
        : margin.kind === 'fixed'
          ? { kind: margin.kind, amountMinor: margin.amountMinor }
          : { kind: margin.kind },
    roundingStepMinor: settings.roundingStepMinor,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The body parseDeliverySettings reads, from the values of a request; null when they are not a
 * set of settings (a request this module did not write).
 */
export function settingsInputOf(values: unknown): Record<string, unknown> | null {
  if (!isRecord(values) || typeof values.sameDayCutoffMinutes !== 'number') return null;
  const minutes = values.sameDayCutoffMinutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) return null;
  const rest = Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== 'sameDayCutoffMinutes'),
  );
  return { ...rest, sameDayCutoff: formatCutoff(minutes) };
}

/** The methods a seller does not support as the values of a request, in the canonical order. */
export const unsupportedValues = (methods: readonly DeliveryMethod[]): ChangeValues => ({
  unsupported: DELIVERY_METHODS.filter((method) => methods.includes(method)),
});

/** A signed-in admin session, not acting as someone else (a revert is the decider's own act). */
export function reverterOf(context: CallContext): ActorId {
  const actor = context.actor;
  const acting =
    Object.hasOwn(actor, 'actingAs') && (actor as { readonly actingAs?: unknown }).actingAs != null;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || acting) {
    throw new Error('shipping: a revert needs a signed-in admin acting as themselves');
  }
  return actor.accountId;
}
