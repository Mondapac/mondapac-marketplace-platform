import { err, ok, parseMinorUnits, parseMoney } from '@mondapac/shared-kernel';
import type { Money, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import { isFleetCode, type FleetCode } from './fleet';

// The fees a fleet charges the platform (delivery models, package 5): a cancellation after the
// fleet was dispatched, a courier kept waiting, a parcel returned. The buyer is never charged them;
// the platform records each one the fleet reports, with a reason code, so finance can reconcile the
// fleet's invoice. Adapters report them through the shipping facade's `recordFleetFee`.

export const FLEET_FEE_REASONS = ['cancel', 'waiting', 'return', 'other'] as const;
export type FleetFeeReason = (typeof FLEET_FEE_REASONS)[number];

/** The most characters of the fleet's own id of a fee. */
export const MAX_EXTERNAL_REF = 120;

export interface FleetFeeReport {
  readonly fleet: FleetCode;
  readonly sellerOrderId: string;
  readonly reason: FleetFeeReason;
  /** Above zero, in the Market currency. */
  readonly amount: Money;
  /** The fleet's own id of the fee, or a stable key the adapter derives: a repeat records once. */
  readonly externalRef: string;
  readonly occurredAt: Temporal.Instant;
}

type Field = { readonly path: string; readonly code: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A fee as an adapter reports it: the amount as a string of minor units (or a bigint) in the Market
 * currency, an ISO instant, a known reason and fleet. Every field problem is named.
 */
export function parseFleetFeeReport(
  input: unknown,
  currency: string,
): Result<FleetFeeReport, readonly Field[]> {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const fields: Field[] = [];
  const fleet = isFleetCode(value.fleet) ? value.fleet : null;
  if (fleet === null) fields.push({ path: 'fleet', code: 'value' });
  const sellerOrderId =
    typeof value.sellerOrderId === 'string' && UUID.test(value.sellerOrderId)
      ? value.sellerOrderId.toLowerCase()
      : null;
  if (sellerOrderId === null) fields.push({ path: 'sellerOrderId', code: 'format' });
  const reason = FLEET_FEE_REASONS.find((candidate) => candidate === value.reason);
  if (reason === undefined) fields.push({ path: 'reason', code: 'value' });
  const minor =
    typeof value.amount === 'bigint'
      ? ok(value.amount)
      : parseMinorUnits(typeof value.amount === 'number' ? String(value.amount) : value.amount);
  const amount = minor.ok && minor.value > 0n ? parseMoney(minor.value, currency) : null;
  if (amount === null || !amount.ok) fields.push({ path: 'amount', code: 'range' });
  const externalRef =
    typeof value.externalRef === 'string' &&
    value.externalRef.length >= 1 &&
    value.externalRef.length <= MAX_EXTERNAL_REF
      ? value.externalRef
      : null;
  if (externalRef === null) fields.push({ path: 'externalRef', code: 'length' });
  let occurredAt: Temporal.Instant | null;
  try {
    occurredAt =
      typeof value.occurredAt === 'string' ? Temporal.Instant.from(value.occurredAt) : null;
  } catch {
    occurredAt = null;
  }
  if (occurredAt === null) fields.push({ path: 'occurredAt', code: 'format' });
  if (
    fields.length > 0 ||
    fleet === null ||
    sellerOrderId === null ||
    reason === undefined ||
    amount === null ||
    !amount.ok ||
    externalRef === null ||
    occurredAt === null
  ) {
    return err(fields);
  }
  return ok({ fleet, sellerOrderId, reason, amount: amount.value, externalRef, occurredAt });
}
