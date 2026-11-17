import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { CustomerAddressRevealed } from '../domain/audit';
import type { AddressRecord } from './ports/address.repository';
import type { CustomerManagementDependencies } from './customer-management-dependencies';
import { adminAccountOf, invalidField, isRecord } from './customer-list-flow';
import { accountIdOf } from './customer-page-flow';
import type { NoteFailure } from './customer-notes-flow';

// A customer's delivery addresses on the customer page (customers management phase 2b). By default
// each address shows only its suburb and country; the full address needs the protected
// `customers.customer-address.reveal`, one address at a time, and every reveal writes an audit row
// and a timeline entry in one unit before the content is answered. The content is opened outside
// the unit (the subject key is identity's) and never reaches a log or an error.

export type CustomerAddressFailure = NoteFailure | { readonly code: 'customers.address-not-found' };

/** One address as the page shows it without the reveal key. */
export interface CustomerAddressSummary {
  readonly addressId: string;
  /** Null when the customer's key was destroyed (the account is being erased). */
  readonly suburb: string | null;
  readonly countryCode: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}

/** One address in full, after an audited reveal. */
export interface CustomerAddressRevealView {
  readonly addressId: string;
  readonly countryCode: string;
  readonly recipientFirstName: string;
  readonly recipientLastName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly suburb: string;
  readonly region: string | null;
  readonly postcode: string;
  readonly deliveryNotes: string | null;
}

function closedInput(
  input: unknown,
  allowed: readonly string[],
): Result<Record<string, unknown>, CustomerAddressFailure> {
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return invalidField(key, 'unknown');
  }
  return ok(input);
}

/** The customer's addresses, default first then newest, as suburb and country only. */
export async function listCustomerAddresses(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<{ readonly items: readonly CustomerAddressSummary[] }, CustomerAddressFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  const closed = closedInput(input, ['accountId']);
  if (!closed.ok) return closed;
  const accountId = accountIdOf(closed.value['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
      if (row === undefined) return err({ code: 'customers.customer-not-found' as const });
      return ok(await deps.addresses.list(context.market, accountId));
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const items: CustomerAddressSummary[] = [];
  for (const record of [...read.value].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))) {
    const opened = await deps.addressCipher.open(context.market, accountId, record.sealed);
    items.push({
      addressId: record.id,
      suburb: opened.ok ? opened.value.suburb : null,
      countryCode: record.countryCode,
      isDefault: record.isDefault,
      createdAt: record.createdAt.toString(),
    });
  }
  return ok({ items });
}

/**
 * Reveals one address in full. The address is read and opened first; then one unit checks the
 * customer is still in the directory, writes the audit row (the address id) and the timeline entry
 * (`address-revealed`); only after it commits is the content answered.
 */
export async function revealCustomerAddress(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<CustomerAddressRevealView, CustomerAddressFailure>> {
  const me = adminAccountOf(context);
  if (me === null) return err({ code: 'access.denied' });
  const closed = closedInput(input, ['accountId', 'addressId']);
  if (!closed.ok) return closed;
  const accountId = accountIdOf(closed.value['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const rawAddress = closed.value['addressId'];
  const parsedAddress =
    typeof rawAddress === 'string' ? parseId<'CustomerAddress'>(rawAddress) : null;
  if (parsedAddress === null || !parsedAddress.ok) {
    return err({ code: 'customers.address-not-found' });
  }
  const addressId: Id<'CustomerAddress'> = parsedAddress.value;
  const found = await deps.unitOfWork.run<AddressRecord, CustomerAddressFailure>(
    context.market,
    async () => {
      const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
      if (row === undefined) return err({ code: 'customers.customer-not-found' });
      const record = await deps.addresses.find(context.market, accountId, addressId);
      return record === null ? err({ code: 'customers.address-not-found' }) : ok(record);
    },
    { readOnly: true },
  );
  if (!found.ok) return found;
  const opened = await deps.addressCipher.open(context.market, accountId, found.value.sealed);
  // No key: the account is being erased; its addresses are gone for good.
  if (!opened.ok) return err({ code: 'customers.address-not-found' });
  const written = await deps.unitOfWork.run<true, CustomerAddressFailure>(
    context.market,
    async () => {
      const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
      if (row === undefined) return err({ code: 'customers.customer-not-found' });
      await deps.audit.record(
        context,
        CustomerAddressRevealed.entry(accountId, { after: { addressId } }),
      );
      const now = deps.clock.now();
      await deps.timeline.record(
        context.market,
        {
          id: deps.ids.next<'CustomerTimelineEntry'>(),
          accountId,
          occurredAt: now,
          kind: 'address-revealed',
          ref: null,
          actorAccountId: me,
          detail: 'address',
          sourceEventId: null,
        },
        now,
      );
      return ok(true);
    },
  );
  if (!written.ok) return written;
  const content = opened.value;
  return ok({
    addressId,
    countryCode: found.value.countryCode,
    recipientFirstName: content.recipientFirstName,
    recipientLastName: content.recipientLastName,
    phone: content.phone,
    line1: content.line1,
    line2: content.line2,
    suburb: content.suburb,
    region: content.region,
    postcode: content.postcode,
    deliveryNotes: content.deliveryNotes,
  });
}
