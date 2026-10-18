import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { parseAddress, type AddressContent, type FieldProblem } from '../domain/address';
import type { CustomersDependencies } from './customers-dependencies';
import type { AddressRecord } from './ports/address.repository';

// The customer's delivery address book (customers package 1): a signed-in customer lists, adds,
// changes and removes their own addresses and picks the default one, up to the Market's limit.
// The first address becomes the default; removing the default makes the newest remaining
// address the default, so a book that is not empty always has exactly one. Checkout (package 2)
// copies the chosen address onto the order, so a later change never touches a placed order.
// No address value reaches a log, an event, an audit row or an error.

export type AddressBookFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'customers.address-not-found' }
  /** The book already holds the Market's limit of addresses. */
  | { readonly code: 'customers.address-limit-reached'; readonly limit: number }
  | { readonly code: 'customers.unavailable' };

export interface AddressView extends AddressContent {
  readonly id: Id<'CustomerAddress'>;
  readonly countryCode: string;
  readonly isDefault: boolean;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface AddressBookView {
  /** The default address first, then newest first. */
  readonly addresses: readonly AddressView[];
  readonly limit: number;
}

/** The input of an add or a change: the address fields and the optional `isDefault`. */
export type AddressInput = Readonly<Record<string, unknown>>;

/** Spans rows (the limit, the one default), so the writes run serializable and are retried. */
const SERIAL = { isolation: 'serializable' } as const;

/** The signed-in customer's account; null for any other actor (fail closed). */
function customerOf(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'customer' ? actor.accountId : null;
}

const addressIdOf = (value: unknown): Id<'CustomerAddress'> | null => {
  const parsed = typeof value === 'string' ? parseId<'CustomerAddress'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

const invalid = (path: string, code: string): AddressBookFailure => ({
  code: 'validation.failed',
  fields: [{ path, code }],
});

const viewOf = (record: AddressRecord, content: AddressContent): AddressView => ({
  ...content,
  id: record.id,
  countryCode: record.countryCode,
  isDefault: record.isDefault,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/** Parses the body of an add or a change: the address, and `isDefault` (absent, true or false). */
function parseInput(
  input: AddressInput,
  format: Parameters<typeof parseAddress>[1],
): Result<{ content: AddressContent; makeDefault: boolean }, AddressBookFailure> {
  const problems: FieldProblem[] = [];
  const flag = input?.isDefault;
  if (flag !== undefined && typeof flag !== 'boolean') {
    problems.push({ path: 'isDefault', code: 'type' });
  }
  const content = parseAddress(input, format);
  if (!content.ok) problems.push(...content.error);
  if (!content.ok || problems.length > 0) {
    return err({ code: 'validation.failed', fields: problems });
  }
  return ok({ content: content.value, makeDefault: flag === true });
}

/** Opens each sealed address; an address whose key was destroyed is gone and left out. */
async function openAll(
  deps: CustomersDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  records: readonly AddressRecord[],
): Promise<AddressView[]> {
  const views: AddressView[] = [];
  for (const record of records) {
    const opened = await deps.cipher.open(context.market, accountId, record.sealed);
    if (opened.ok) views.push(viewOf(record, opened.value));
  }
  return views.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** The customer reads their address book. */
export async function listAddresses(
  deps: CustomersDependencies,
  context: CallContext,
): Promise<Result<AddressBookView, AddressBookFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'customers.unavailable' });
  const records = await deps.unitOfWork.run<readonly AddressRecord[], AddressBookFailure>(
    context.market,
    async () => ok(await deps.addresses.list(context.market, accountId)),
    { readOnly: true },
  );
  if (!records.ok) return records;
  return ok({
    addresses: await openAll(deps, context, accountId, records.value),
    limit: settings.limit,
  });
}

/** The customer adds an address; the first one, or one sent with `isDefault: true`, is the default. */
export async function createAddress(
  deps: CustomersDependencies,
  context: CallContext,
  input: AddressInput,
): Promise<Result<AddressView, AddressBookFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'customers.unavailable' });
  const parsed = parseInput(input, settings.format);
  if (!parsed.ok) return parsed;
  const sealed = await deps.cipher.seal(context.market, accountId, parsed.value.content);
  if (!sealed.ok) return err({ code: 'access.denied' });

  const now = deps.clock.now();
  const id = deps.ids.next<'CustomerAddress'>();
  return deps.unitOfWork.run<AddressView, AddressBookFailure>(
    context.market,
    async () => {
      const existing = await deps.addresses.list(context.market, accountId);
      if (existing.length >= settings.limit) {
        return err({ code: 'customers.address-limit-reached', limit: settings.limit } as const);
      }
      const isDefault = parsed.value.makeDefault || !existing.some((record) => record.isDefault);
      if (isDefault) await deps.addresses.clearDefault(context.market, accountId, now);
      const record: AddressRecord = {
        id,
        accountId,
        sealed: sealed.value,
        countryCode: settings.format.countryCode,
        isDefault,
        createdAt: now,
        updatedAt: now,
      };
      await deps.addresses.insert(context.market, record);
      return ok(viewOf(record, parsed.value.content));
    },
    SERIAL,
  );
}

/**
 * The customer changes an address (the whole address is replaced). `isDefault: true` also makes
 * it the default; `false` never clears the default, which moves only to another address.
 */
export async function updateAddress(
  deps: CustomersDependencies,
  context: CallContext,
  input: { readonly addressId: unknown; readonly body: AddressInput },
): Promise<Result<AddressView, AddressBookFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const id = addressIdOf(input?.addressId);
  if (id === null) return err(invalid('addressId', 'format'));
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'customers.unavailable' });
  const parsed = parseInput(input.body, settings.format);
  if (!parsed.ok) return parsed;
  const sealed = await deps.cipher.seal(context.market, accountId, parsed.value.content);
  if (!sealed.ok) return err({ code: 'access.denied' });

  const now = deps.clock.now();
  return deps.unitOfWork.run<AddressView, AddressBookFailure>(
    context.market,
    async () => {
      const before = await deps.addresses.find(context.market, accountId, id);
      if (before === null) return err({ code: 'customers.address-not-found' } as const);
      await deps.addresses.update(context.market, {
        id,
        accountId,
        sealed: sealed.value,
        updatedAt: now,
      });
      const isDefault = before.isDefault || parsed.value.makeDefault;
      if (!before.isDefault && isDefault) {
        await deps.addresses.clearDefault(context.market, accountId, now);
        await deps.addresses.markDefault(context.market, accountId, id, now);
      }
      return ok(
        viewOf(
          { ...before, sealed: sealed.value, isDefault, updatedAt: now },
          parsed.value.content,
        ),
      );
    },
    SERIAL,
  );
}

/** The customer removes an address; when it was the default, the newest remaining one is. */
export async function deleteAddress(
  deps: CustomersDependencies,
  context: CallContext,
  input: { readonly addressId: unknown },
): Promise<Result<{ readonly deleted: true }, AddressBookFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const id = addressIdOf(input?.addressId);
  if (id === null) return err(invalid('addressId', 'format'));
  if (deps.policy.settings(context.market) === null) return err({ code: 'customers.unavailable' });

  const now = deps.clock.now();
  return deps.unitOfWork.run<{ readonly deleted: true }, AddressBookFailure>(
    context.market,
    async () => {
      const before = await deps.addresses.find(context.market, accountId, id);
      if (before === null) return err({ code: 'customers.address-not-found' } as const);
      await deps.addresses.remove(context.market, accountId, id);
      if (before.isDefault) {
        const [newest] = await deps.addresses.list(context.market, accountId);
        if (newest !== undefined) {
          await deps.addresses.markDefault(context.market, accountId, newest.id, now);
        }
      }
      return ok({ deleted: true } as const);
    },
    SERIAL,
  );
}

/** The customer picks the default address; answers the book as it now stands. */
export async function setDefaultAddress(
  deps: CustomersDependencies,
  context: CallContext,
  input: { readonly addressId: unknown },
): Promise<Result<AddressBookView, AddressBookFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const id = addressIdOf(input?.addressId);
  if (id === null) return err(invalid('addressId', 'format'));
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'customers.unavailable' });

  const now = deps.clock.now();
  const records = await deps.unitOfWork.run<readonly AddressRecord[], AddressBookFailure>(
    context.market,
    async () => {
      const target = await deps.addresses.find(context.market, accountId, id);
      if (target === null) return err({ code: 'customers.address-not-found' } as const);
      if (!target.isDefault) {
        await deps.addresses.clearDefault(context.market, accountId, now);
        await deps.addresses.markDefault(context.market, accountId, id, now);
      }
      return ok(await deps.addresses.list(context.market, accountId));
    },
    SERIAL,
  );
  if (!records.ok) return records;
  return ok({
    addresses: await openAll(deps, context, accountId, records.value),
    limit: settings.limit,
  });
}

/** One address as checkout copies it onto an order: the content and its country. */
export interface DeliveryAddressView extends AddressContent {
  readonly countryCode: string;
}

/**
 * Checkout reads one of the customer's own addresses (customers package 2) to copy it onto the
 * order. Unknown, foreign and erased are one answer.
 */
export async function readDeliveryAddress(
  deps: CustomersDependencies,
  context: CallContext,
  input: { readonly addressId: unknown },
): Promise<Result<DeliveryAddressView, AddressBookFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const id = addressIdOf(input?.addressId);
  if (id === null) return err(invalid('addressId', 'format'));
  if (deps.policy.settings(context.market) === null) return err({ code: 'customers.unavailable' });
  const record = await deps.unitOfWork.run<AddressRecord, AddressBookFailure>(
    context.market,
    async () => {
      const found = await deps.addresses.find(context.market, accountId, id);
      return found === null ? err({ code: 'customers.address-not-found' } as const) : ok(found);
    },
    { readOnly: true },
  );
  if (!record.ok) return record;
  const opened = await deps.cipher.open(context.market, accountId, record.value.sealed);
  if (!opened.ok) return err({ code: 'customers.address-not-found' });
  return ok({ ...opened.value, countryCode: record.value.countryCode });
}
