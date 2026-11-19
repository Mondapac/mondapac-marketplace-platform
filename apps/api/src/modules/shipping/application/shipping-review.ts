import { createHash } from 'node:crypto';
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
// restored by the reverters in shipping-reverters.ts.
//
// Owner decision of 18 Nov 2026 ("mixed"): a model has no delete, so its create cannot be undone
// by a reviewer; it waits for a second admin's approval instead (approval mode, the applier in
// shipping-appliers.ts).

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
/**
 * A new fleet-selection model (approval mode: a model has no delete, so a create cannot be
 * undone); subject = the name asked for, normalised (see {@link fleetModelNameRef}).
 */
export const FLEET_MODEL_CREATE_SUBJECT_KIND = 'shipping.fleet-selection-model-create';

/** What a subject ref may hold (system-requests' `SUBJECT_REF`, 128 characters at most). */
const REF_MAX = 128;

/**
 * The subject of a proposed model: its name as the Market compares names (NFC, trimmed, any case),
 * so two proposals of one name share a subject and the second is `already-pending`. A subject ref
 * holds only `[A-Za-z0-9._:-]`: the name folded to lower case keeps `a-z`, `0-9` and `-`, and
 * every other character becomes `_<hex code point>.` (an exact, reversible spelling, readable
 * for a Latin name). A spelling over 128 characters (a long name in another script) is the
 * SHA-256 of the folded name instead. The two forms never meet (`name:` and `name-sha256:`).
 *
 * Case is folded here with JavaScript's `toLowerCase`, while `nameTaken` and `insertModel` use
 * the database's case-insensitive comparison. For a few code points the two can differ: two names
 * the database treats as one may then get two subjects, so a second proposal is filed instead of
 * `already-pending`. That is harmless: the approval of the later one finds the name taken and
 * answers `changed-since`, and nothing wrong is written.
 */
export function fleetModelNameRef(name: string): string {
  const folded = name.normalize('NFC').trim().toLowerCase();
  let spelled = '';
  for (const char of folded) {
    spelled += /^[a-z0-9-]$/.test(char) ? char : `_${(char.codePointAt(0) ?? 0).toString(16)}.`;
  }
  const readable = `name:${spelled}`;
  if (readable.length <= REF_MAX) return readable;
  return `name-sha256:${createHash('sha256').update(folded, 'utf8').digest('hex')}`;
}

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
 * What an action that waits for approval answers instead of its usual answer: the proposal it
 * filed (HTTP 202); nothing was written in shipping.
 */
export interface ShippingProposal {
  readonly request: NonNullable<ShippingRequestRef>;
}

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

/** Whether the session acts as someone else (Login as Seller): no write of this area runs in one. */
export function isActingAs(context: CallContext): boolean {
  const actor = context.actor;
  return (
    Object.hasOwn(actor, 'actingAs') && (actor as { readonly actingAs?: unknown }).actingAs != null
  );
}

/** A signed-in admin session, not acting as someone else (a revert is the decider's own act). */
export function reverterOf(context: CallContext): ActorId {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    throw new Error('shipping: a revert needs a signed-in admin acting as themselves');
  }
  return actor.accountId;
}
