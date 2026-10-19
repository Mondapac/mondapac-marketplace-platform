'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
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

interface AccountState {
  readonly source: AccountSource;
  readonly profile: Profile;
  readonly setProfile: (profile: Profile) => void;
  readonly orders: readonly AccountOrder[];
  /** Cancels an order no seller has confirmed yet; others are left as they are. */
  readonly cancelOrder: (reference: string) => void;
  readonly addresses: readonly SavedAddress[];
  /** Adds an address (a new id) or replaces the one with its id. */
  readonly saveAddress: (address: SavedAddress) => void;
  readonly makeDefault: (id: string) => void;
  /** Deletes an address; when it was the default, the first one left becomes the default. */
  readonly deleteAddress: (id: string) => void;
  readonly lists: readonly NamedList[];
  readonly createList: (name: string) => void;
  readonly emails: EmailChoices;
  readonly setEmail: (key: keyof EmailChoices, on: boolean) => void;
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
 * The account pages' client state, kept while the buyer moves between them. Sample: changes stay
 * in this browser tab until the account backend exists (handoffs/account.md).
 */
export function AccountProvider({
  source,
  children,
}: {
  readonly source: AccountSource;
  readonly children: ReactNode;
}) {
  const [profile, setProfile] = useState<Profile>({
    fullName: source.customer.fullName,
    email: source.customer.email,
    mobile: source.mobile,
  });
  const [orders, setOrders] = useState(source.orders);
  const [addresses, setAddresses] = useState(source.customer.addresses);
  const [lists, setLists] = useState(source.lists);
  const [emails, setEmails] = useState(source.emails);

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
  const saveAddress = useCallback(
    (address: SavedAddress) =>
      setAddresses((current) =>
        current.some((a) => a.id === address.id)
          ? current.map((a) => (a.id === address.id ? address : a))
          : [...current, { ...address, isDefault: current.length === 0 }],
      ),
    [],
  );
  const makeDefault = useCallback(
    (id: string) =>
      setAddresses((current) => current.map((a) => ({ ...a, isDefault: a.id === id }))),
    [],
  );
  const deleteAddress = useCallback(
    (id: string) =>
      setAddresses((current) => {
        const left = current.filter((a) => a.id !== id);
        if (left.length > 0 && !left.some((a) => a.isDefault))
          return left.map((a, i) => ({ ...a, isDefault: i === 0 }));
        return left;
      }),
    [],
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

  const value = useMemo(
    () => ({
      source,
      profile,
      setProfile,
      orders,
      cancelOrder,
      addresses,
      saveAddress,
      makeDefault,
      deleteAddress,
      lists,
      createList,
      emails,
      setEmail,
    }),
    [
      source,
      profile,
      orders,
      cancelOrder,
      addresses,
      saveAddress,
      makeDefault,
      deleteAddress,
      lists,
      createList,
      emails,
      setEmail,
    ],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  const state = useContext(AccountContext);
  if (!state) throw new Error('useAccount outside AccountProvider');
  return state;
}
