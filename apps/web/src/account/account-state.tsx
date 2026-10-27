'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Palette, TextSize } from '../preferences/preferences.ts';
import { useStore } from '../shell/store-context.tsx';
import * as api from './customer-api.ts';
import type {
  AccountOrder,
  AccountSource,
  EmailChoices,
  Money,
  NamedList,
  OrderPart,
  SavedAddress,
} from '../storefront/types.ts';

/** The profile fields of Settings. */
export interface Profile {
  readonly fullName: string;
  readonly email: string;
  readonly mobile: string;
}

/** A signed-in customer's look, saved to their account (the browser keeps a copy for first paint). */
export interface Appearance {
  readonly palette?: Palette;
  readonly textSize?: TextSize;
}

/** How a save ended: done, or refused with the fields to fix (`invalid`) or a limit or a failure. */
export type SaveOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'limit' | 'failed';
      readonly fields: readonly api.FieldProblem[];
    };

/** How a password change ended; each refusal has its own message. */
export type PasswordOutcome =
  'ok' | 'current-incorrect' | 'rejected' | 'invalid' | 'throttled' | 'failed';

const SAVED: SaveOutcome = { ok: true };
const FAILED: SaveOutcome = { ok: false, reason: 'failed', fields: [] };

interface AccountState {
  readonly source: AccountSource;
  readonly profile: Profile;
  /** Saves the profile. Live: only the name goes to the API (email and mobile are not editable). */
  readonly saveProfile: (profile: Profile) => Promise<SaveOutcome>;
  /** Changes the password. Sample: always done. */
  readonly changePassword: (current: string, next: string) => Promise<PasswordOutcome>;
  readonly orders: readonly AccountOrder[];
  /** Cancels an order no seller has confirmed yet; others are left as they are. */
  readonly cancelOrder: (reference: string) => void;
  /**
   * Gets a new pickup code for one seller's part: the old code stops working and a lock from
   * wrong tries is lifted. Orders are sample data until their backend is wired; then this calls
   * `POST /orders/{id}/pickup/{sellerId}/regenerate`, which answers the new code to the buyer only.
   */
  readonly renewPickupCode: (reference: string, sellerId: string) => void;
  readonly addresses: readonly SavedAddress[];
  /** Adds an address (empty id) or replaces the one with its id. */
  readonly saveAddress: (address: SavedAddress) => Promise<SaveOutcome>;
  readonly makeDefault: (id: string) => Promise<SaveOutcome>;
  /** Deletes an address; when it was the default, the first one left becomes the default. */
  readonly deleteAddress: (id: string) => Promise<SaveOutcome>;
  readonly lists: readonly NamedList[];
  readonly createList: (name: string) => void;
  readonly emails: EmailChoices;
  readonly setEmail: (key: keyof EmailChoices, on: boolean) => void;
  readonly appearance: Appearance;
  /** Saves a look change to the account (live: both values go to the API; sample: this tab only). */
  readonly saveAppearance: (change: Appearance) => void;
}

const AccountContext = createContext<AccountState | null>(null);

/** Whether every seller of an in-progress order is still to confirm it (it can be cancelled). */
export function cancellable(order: AccountOrder): boolean {
  return order.status === 'in-progress' && order.parts.every((p) => p.status === 'waiting');
}

function cancelParts([first, ...rest]: AccountOrder['parts']): AccountOrder['parts'] {
  const cancel = (part: OrderPart): OrderPart => ({ ...part, status: 'cancelled' });
  return [cancel(first), ...rest.map(cancel)];
}

/** The item count, items subtotal, delivery fees and total of an order. */
export function orderTotals(order: AccountOrder): {
  count: number;
  items: Money;
  delivery: Money;
  total: Money;
} {
  const currency = order.includedTax.currency;
  let count = 0;
  let items = 0;
  let delivery = 0;
  for (const part of order.parts) {
    delivery += part.deliveryFee.amount;
    for (const line of part.lines) {
      count += line.quantity;
      items += line.unitPrice.amount * line.quantity;
    }
  }
  return {
    count,
    items: { amount: items, currency },
    delivery: { amount: delivery, currency },
    total: { amount: items + delivery, currency },
  };
}

/**
 * The account pages' client state, kept while the buyer moves between them. Live, the profile name,
 * password, look and address book go to the API; orders, lists and email choices, and everything
 * in sample mode, stay in this browser tab until their backends exist (handoffs/account.md).
 */
export function AccountProvider({
  source,
  children,
}: {
  readonly source: AccountSource;
  readonly children: ReactNode;
}) {
  const live = source.live;
  const { setCustomer } = useStore();
  const [profile, setProfile] = useState<Profile>({
    fullName: source.customer.fullName,
    email: source.customer.email,
    mobile: source.mobile,
  });
  const [orders, setOrders] = useState(source.orders);
  const [addresses, setAddresses] = useState(source.customer.addresses);
  const [lists, setLists] = useState(source.lists);
  const [emails, setEmails] = useState(source.emails);
  const [appearance, setAppearance] = useState<Appearance>({});

  const cancelOrder = useCallback(
    (reference: string) =>
      setOrders((current) =>
        current.map((o) =>
          o.reference === reference && cancellable(o)
            ? {
                ...o,
                status: 'cancelled' as const,
                parts: cancelParts(o.parts),
              }
            : o,
        ),
      ),
    [],
  );
  const renewPickupCode = useCallback(
    (reference: string, sellerId: string) =>
      setOrders((current) =>
        current.map((o) =>
          o.reference === reference
            ? {
                ...o,
                parts: o.parts.map((p) =>
                  p.sellerId === sellerId && p.pickup
                    ? { ...p, pickup: { code: '7319', attemptsLeft: 5, locked: false } }
                    : p,
                ) as unknown as AccountOrder['parts'],
              }
            : o,
        ),
      ),
    [],
  );
  // Live: a 401 means the session ended, so the store signs the buyer out (the log-in page shows).
  const settle = useCallback(
    (result: api.ApiResult<unknown>): SaveOutcome => {
      switch (result.kind) {
        case 'ok':
          return SAVED;
        case 'invalid':
          return {
            ok: false,
            reason: result.code === 'customers.address-limit-reached' ? 'limit' : 'invalid',
            fields: result.fields,
          };
        case 'signed-out':
          setCustomer(null);
          return FAILED;
        default:
          return FAILED;
      }
    },
    [setCustomer],
  );
  // Live: the book as the API holds it, also given to the store for checkout.
  const adoptBook = useCallback(
    (book: readonly SavedAddress[]) => {
      setAddresses(book);
      setCustomer((current) => (current ? { ...current, addresses: book } : current));
    },
    [setCustomer],
  );
  const reload = useCallback(
    async (result: api.ApiResult<unknown>): Promise<SaveOutcome> => {
      if (result.kind !== 'ok') return settle(result);
      const book = await api.listAddresses();
      if (book.kind === 'ok') adoptBook(book.value);
      return book.kind === 'ok' ? SAVED : settle(book);
    },
    [settle, adoptBook],
  );
  const saveAddress = useCallback(
    async (address: SavedAddress): Promise<SaveOutcome> => {
      if (live) {
        const input = {
          firstName: address.firstName,
          lastName: address.lastName,
          phone: address.phone,
          street: address.street,
          line2: address.line2,
          suburb: address.suburb,
          region: source.serviceArea.regionCode,
          postcode: address.postcode,
          deliveryNotes: address.deliveryNotes,
        };
        return reload(
          await (address.id === ''
            ? api.createAddress(input)
            : api.updateAddress(address.id, input)),
        );
      }
      setAddresses((current) =>
        current.some((a) => a.id === address.id)
          ? current.map((a) => (a.id === address.id ? address : a))
          : [
              ...current,
              { ...address, id: `address-${Date.now()}`, isDefault: current.length === 0 },
            ],
      );
      return SAVED;
    },
    [live, reload, source.serviceArea.regionCode],
  );
  const makeDefault = useCallback(
    async (id: string): Promise<SaveOutcome> => {
      if (live) {
        const result = await api.makeDefaultAddress(id);
        if (result.kind === 'ok') adoptBook(result.value);
        return settle(result);
      }
      setAddresses((current) => current.map((a) => ({ ...a, isDefault: a.id === id })));
      return SAVED;
    },
    [live, settle, adoptBook],
  );
  const deleteAddress = useCallback(
    async (id: string): Promise<SaveOutcome> => {
      if (live) return reload(await api.deleteAddress(id));
      setAddresses((current) => {
        const left = current.filter((a) => a.id !== id);
        if (left.length > 0 && !left.some((a) => a.isDefault))
          return left.map((a, i) => ({ ...a, isDefault: i === 0 }));
        return left;
      });
      return SAVED;
    },
    [live, reload],
  );
  const saveProfile = useCallback(
    async (next: Profile): Promise<SaveOutcome> => {
      if (live) {
        const name = next.fullName.trim();
        const result = await api.saveDisplayName(name);
        if (result.kind !== 'ok') return settle(result);
        setProfile((current) => ({ ...current, fullName: name }));
        setCustomer((current) =>
          current
            ? { ...current, fullName: name, firstName: name.split(/\s+/)[0] ?? name }
            : current,
        );
        return SAVED;
      }
      setProfile(next);
      return SAVED;
    },
    [live, settle, setCustomer],
  );
  const changePassword = useCallback(
    async (current: string, next: string): Promise<PasswordOutcome> => {
      if (!live) return 'ok';
      const result = await api.changePassword(current, next);
      if (result.kind === 'ok') return 'ok';
      if (result.kind === 'throttled') return 'throttled';
      if (result.kind === 'signed-out') setCustomer(null);
      if (result.kind !== 'invalid') return 'failed';
      if (result.code === 'password.current-incorrect') return 'current-incorrect';
      if (result.code === 'password.rejected') return 'rejected';
      return result.code === 'validation.failed' ? 'invalid' : 'failed';
    },
    [live, setCustomer],
  );
  const createList = useCallback(
    (name: string) =>
      setLists((current) => [...current, { id: `list-${current.length + 1}`, name, offerIds: [] }]),
    [],
  );
  const setEmail = useCallback(
    (key: keyof EmailChoices, on: boolean) => setEmails((current) => ({ ...current, [key]: on })),
    [],
  );
  const saveAppearance = useCallback(
    (change: Appearance) => {
      const merged = { ...appearance, ...change };
      setAppearance(merged);
      if (live)
        void api
          .saveAppearance({ palette: merged.palette ?? null, textSize: merged.textSize ?? null })
          .then((result) => {
            if (result.kind === 'signed-out') setCustomer(null);
          });
    },
    [appearance, live, setCustomer],
  );

  const value = useMemo(
    () => ({
      source,
      profile,
      saveProfile,
      changePassword,
      orders,
      cancelOrder,
      renewPickupCode,
      addresses,
      saveAddress,
      makeDefault,
      deleteAddress,
      lists,
      createList,
      emails,
      setEmail,
      appearance,
      saveAppearance,
    }),
    [
      source,
      profile,
      saveProfile,
      changePassword,
      orders,
      cancelOrder,
      renewPickupCode,
      addresses,
      saveAddress,
      makeDefault,
      deleteAddress,
      lists,
      createList,
      emails,
      setEmail,
      appearance,
      saveAppearance,
    ],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  const state = useContext(AccountContext);
  if (!state) throw new Error('useAccount outside AccountProvider');
  return state;
}
