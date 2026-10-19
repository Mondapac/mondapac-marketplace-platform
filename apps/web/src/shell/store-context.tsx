'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { addOne, removeLine, removeOne, type Cart, type CartView } from '../cart/cart.ts';
import type { CartSource, CheckoutCustomer, Money } from '../storefront/types.ts';

/** What the confirmation shows of the order just placed. */
export interface PlacedOrder {
  readonly reference: string;
  readonly view: CartView;
  readonly address: string;
}

const NO_SOURCE: CartSource = {
  items: {},
  sellers: {},
  tax: { share: { numerator: 0, denominator: 1 }, includesDelivery: false },
};

interface StoreState {
  readonly cart: Cart;
  readonly add: (id: string, unitPrice: Money, limit: number) => void;
  readonly remove: (id: string) => void;
  /** Removes a whole line (the Remove link). */
  readonly removeLine: (id: string) => void;
  readonly clearCart: () => void;
  readonly cartSource: CartSource;
  /** The cart drawer of the header's cart button. */
  readonly cartOpen: boolean;
  readonly setCartOpen: (open: boolean) => void;
  /** The signed-in customer at checkout; a sample log-in sets it until sessions are wired. */
  readonly customer: CheckoutCustomer | null;
  readonly setCustomer: (customer: CheckoutCustomer | null) => void;
  /** The delivery address chosen at checkout, as one line. */
  readonly deliveryAddress: string;
  readonly setDeliveryAddress: (address: string) => void;
  readonly placedOrder: PlacedOrder | null;
  readonly setPlacedOrder: (order: PlacedOrder | null) => void;
  readonly browseOpen: boolean;
  readonly setBrowseOpen: (open: boolean) => void;
  readonly searchOpen: boolean;
  readonly setSearchOpen: (open: boolean) => void;
  readonly filtersOpen: boolean;
  readonly setFiltersOpen: (open: boolean) => void;
  /** A page's own modal dialog (the seller card on phone and tablet) is open. */
  readonly dialogOpen: boolean;
  readonly setDialogOpen: (open: boolean) => void;
}

const StoreContext = createContext<StoreState | null>(null);

/** Client state shared by the shell and the page: the cart and the overlays. */
export function StoreProvider({
  cartSource = NO_SOURCE,
  initialCart = {},
  children,
}: {
  readonly cartSource?: CartSource;
  /** The lines to start with (the server cart once it is read; tests). */
  readonly initialCart?: Cart;
  readonly children: ReactNode;
}) {
  const [cart, setCart] = useState<Cart>(initialCart);
  const [cartOpen, setCartOpen] = useState(false);
  const [customer, setCustomer] = useState<CheckoutCustomer | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const add = useCallback(
    (id: string, unitPrice: Money, limit: number) =>
      setCart((current) => addOne(current, id, unitPrice, limit)),
    [],
  );
  const remove = useCallback((id: string) => setCart((current) => removeOne(current, id)), []);
  const dropLine = useCallback((id: string) => setCart((current) => removeLine(current, id)), []);
  const clearCart = useCallback(() => setCart({}), []);
  const value = useMemo(
    () => ({
      cart,
      add,
      remove,
      removeLine: dropLine,
      clearCart,
      cartSource,
      cartOpen,
      setCartOpen,
      customer,
      setCustomer,
      deliveryAddress,
      setDeliveryAddress,
      placedOrder,
      setPlacedOrder,
      browseOpen,
      setBrowseOpen,
      searchOpen,
      setSearchOpen,
      filtersOpen,
      setFiltersOpen,
      dialogOpen,
      setDialogOpen,
    }),
    [
      cart,
      add,
      remove,
      dropLine,
      clearCart,
      cartSource,
      cartOpen,
      customer,
      deliveryAddress,
      placedOrder,
      browseOpen,
      searchOpen,
      filtersOpen,
      dialogOpen,
    ],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreState {
  const state = useContext(StoreContext);
  if (!state) throw new Error('useStore outside StoreProvider');
  return state;
}
