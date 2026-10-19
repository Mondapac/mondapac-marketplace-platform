'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  addOne,
  lineLimit,
  removeLine,
  removeOne,
  type Cart,
  type CartView,
} from '../cart/cart.ts';
import type { DeliverTo } from '../delivery/deliver-to.ts';
import type { AppliedDiscount, CartSource, CheckoutCustomer, Money } from '../storefront/types.ts';

/** What the confirmation shows of the order just placed. */
export interface PlacedOrder {
  readonly reference: string;
  readonly view: CartView;
  readonly address: string;
  readonly discountCode: string | null;
  /** The buyer's note to each seller, by seller id. */
  readonly notes: Readonly<Record<string, string>>;
}

const NO_SOURCE: CartSource = {
  items: {},
  sellers: {},
  tax: { share: { numerator: 0, denominator: 1 }, includesDelivery: false },
  sampleDiscounts: {},
};

interface StoreState {
  readonly cart: Cart;
  readonly add: (id: string, unitPrice: Money, limit: number) => void;
  readonly remove: (id: string) => void;
  /** Removes a whole line (the Remove link). */
  readonly removeLine: (id: string) => void;
  readonly clearCart: () => void;
  readonly cartSource: CartSource;
  /** Saved-for-later offer ids, newest last; not in the cart or its totals. */
  readonly saved: readonly string[];
  readonly saveForLater: (id: string) => void;
  /** Moves a saved item back to the cart (one unit). */
  readonly moveToCart: (id: string) => void;
  readonly removeSaved: (id: string) => void;
  readonly discount: AppliedDiscount | null;
  readonly setDiscount: (discount: AppliedDiscount | null) => void;
  /** Checkout notes to sellers, by seller id. */
  readonly notes: Readonly<Record<string, string>>;
  readonly setNote: (sellerId: string, note: string) => void;
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
  /** The Deliver to modal of the header button. */
  readonly deliverOpen: boolean;
  readonly setDeliverOpen: (open: boolean) => void;
  /** The confirmed delivery location; null shows the storefront's default area. */
  readonly deliverTo: DeliverTo | null;
  readonly setDeliverTo: (to: DeliverTo) => void;
}

const StoreContext = createContext<StoreState | null>(null);

/** Client state shared by the shell and the page: the cart and the overlays. */
export function StoreProvider({
  cartSource = NO_SOURCE,
  initialCart = {},
  initialDeliverTo = null,
  children,
}: {
  readonly cartSource?: CartSource;
  /** The lines to start with (the server cart once it is read; tests). */
  readonly initialCart?: Cart;
  /** The location kept in this browser (the delivery cookie). */
  readonly initialDeliverTo?: DeliverTo | null;
  readonly children: ReactNode;
}) {
  const [cart, setCart] = useState<Cart>(initialCart);
  const [cartOpen, setCartOpen] = useState(false);
  const [customer, setCustomer] = useState<CheckoutCustomer | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [saved, setSaved] = useState<readonly string[]>([]);
  const [discount, setDiscount] = useState<AppliedDiscount | null>(null);
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [deliverTo, setDeliverTo] = useState<DeliverTo | null>(initialDeliverTo);
  const add = useCallback(
    (id: string, unitPrice: Money, limit: number) =>
      setCart((current) => addOne(current, id, unitPrice, limit)),
    [],
  );
  const remove = useCallback((id: string) => setCart((current) => removeOne(current, id)), []);
  const dropLine = useCallback((id: string) => setCart((current) => removeLine(current, id)), []);
  const clearCart = useCallback(() => {
    setCart({});
    setDiscount(null);
    setNotes({});
  }, []);
  const saveForLater = useCallback((id: string) => {
    setCart((current) => removeLine(current, id));
    setSaved((current) => (current.includes(id) ? current : [...current, id]));
  }, []);
  const removeSaved = useCallback(
    (id: string) => setSaved((current) => current.filter((s) => s !== id)),
    [],
  );
  const moveToCart = useCallback(
    (id: string) => {
      const item = cartSource.items[id];
      if (!item) return;
      setSaved((current) => current.filter((s) => s !== id));
      setCart((current) => addOne(current, id, item.price, lineLimit(item.lowStock)));
    },
    [cartSource],
  );
  const setNote = useCallback(
    (sellerId: string, note: string) => setNotes((current) => ({ ...current, [sellerId]: note })),
    [],
  );
  const value = useMemo(
    () => ({
      cart,
      add,
      remove,
      removeLine: dropLine,
      clearCart,
      cartSource,
      saved,
      saveForLater,
      moveToCart,
      removeSaved,
      discount,
      setDiscount,
      notes,
      setNote,
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
      deliverOpen,
      setDeliverOpen,
      deliverTo,
      setDeliverTo,
    }),
    [
      cart,
      add,
      remove,
      dropLine,
      clearCart,
      cartSource,
      saved,
      saveForLater,
      moveToCart,
      removeSaved,
      discount,
      notes,
      setNote,
      cartOpen,
      customer,
      deliveryAddress,
      placedOrder,
      browseOpen,
      searchOpen,
      filtersOpen,
      dialogOpen,
      deliverOpen,
      deliverTo,
    ],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreState {
  const state = useContext(StoreContext);
  if (!state) throw new Error('useStore outside StoreProvider');
  return state;
}
