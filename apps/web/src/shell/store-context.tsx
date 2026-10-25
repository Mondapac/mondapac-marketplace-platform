'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import * as api from '../account/customer-api.ts';
import {
  addOne,
  limitLine,
  lineLimit,
  removeLine,
  removeOne,
  type Cart,
  type CartView,
  type DeliveryChoice,
} from '../cart/cart.ts';
import type { DeliverTo } from '../delivery/deliver-to.ts';
import type {
  AppliedDiscount,
  CartSource,
  CheckoutCustomer,
  DeliverySpeed,
  Money,
} from '../storefront/types.ts';
import { PALETTE_COOKIE, TEXT_SIZE_COOKIE, savePreference } from '../preferences/preferences.ts';
import { checkReachable, reachable } from './connection.ts';

/** How a live sign-in ended; the log-in form shows a message for each refusal. */
export type SignInOutcome = 'ok' | 'wrong' | 'unverified' | 'disabled' | 'throttled' | 'failed';

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
  /** Lowers lines to the stock Pay found left (item id to units left). */
  readonly limitLines: (left: Readonly<Record<string, number>>) => void;
  /**
   * What Pay lowered for stock, by item name, so the cart can say it after checkout sends the
   * buyer back; null once dismissed or after the next checkout.
   */
  readonly stockChanges: readonly StockChange[] | null;
  readonly setStockChanges: (changes: readonly StockChange[] | null) => void;
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
  /**
   * The speed the buyer picked per seller id at checkout (their wish: Express counts only while
   * the courier quotes a price for it). A seller without one is delivered Scheduled.
   */
  readonly deliveryWish: Readonly<Record<string, DeliverySpeed>>;
  readonly setDeliveryWish: (sellerId: string, speed: DeliverySpeed) => void;
  /** The delivery per seller id checkout paid for (fees included), set when Pay is pressed. */
  readonly delivery: Readonly<Record<string, DeliveryChoice>>;
  readonly setDelivery: (delivery: Readonly<Record<string, DeliveryChoice>>) => void;
  /** The cart drawer of the header's cart button. */
  readonly cartOpen: boolean;
  readonly setCartOpen: (open: boolean) => void;
  /** The signed-in customer at checkout; a sample log-in sets it until sessions are wired. */
  readonly customer: CheckoutCustomer | null;
  readonly setCustomer: Dispatch<SetStateAction<CheckoutCustomer | null>>;
  /** The storefront talks to the API: the session below is real; otherwise it is the sample one. */
  readonly live: boolean;
  /** False until the first session read has answered (live mode); the account pages wait for it. */
  readonly sessionReady: boolean;
  /** Live sign-in: signs in, reads the session and sets `customer`. */
  readonly signIn: (email: string, password: string) => Promise<SignInOutcome>;
  /** Ends the session (live) and clears `customer`. */
  /** False when the API could not end the session: the buyer stays signed in. */
  readonly signOut: () => Promise<boolean>;
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
  /** The log-in dialog (header Log in, the rail's My Account, the Account tab when signed out). */
  readonly loginOpen: boolean;
  readonly setLoginOpen: (open: boolean) => void;
  /** The account menu panel of the phone and tablet layout (the Account tab when signed in). */
  readonly accountOpen: boolean;
  readonly setAccountOpen: (open: boolean) => void;
  /** Whether the marketplace answers; offline, the cart cannot change and checkout is blocked. */
  readonly online: boolean;
  /** Try again: checks the connection and updates `online`; resolves to the result. */
  readonly checkConnection: () => Promise<boolean>;
}

/** A line Pay lowered because the stock ran out: units before and after (0: removed). */
export interface StockChange {
  readonly item: string;
  readonly was: number;
  readonly now: number;
}

const StoreContext = createContext<StoreState | null>(null);

/** Client state shared by the shell and the page: the cart and the overlays. */
export function StoreProvider({
  cartSource = NO_SOURCE,
  initialCart = {},
  initialDeliverTo = null,
  initialCustomer = null,
  live = false,
  children,
}: {
  readonly cartSource?: CartSource;
  /** The lines to start with (the server cart once it is read; tests). */
  readonly initialCart?: Cart;
  /** The location kept in this browser (the delivery cookie). */
  readonly initialDeliverTo?: DeliverTo | null;
  /** The signed-in customer to start with (tests; the session once it is read). */
  readonly initialCustomer?: CheckoutCustomer | null;
  /** The storefront talks to the API (`API_BASE_URL` is set). */
  readonly live?: boolean;
  readonly children: ReactNode;
}) {
  const [cart, setCart] = useState<Cart>(initialCart);
  const [cartOpen, setCartOpen] = useState(false);
  const [customer, setCustomer] = useState<CheckoutCustomer | null>(initialCustomer);
  const [sessionReady, setSessionReady] = useState(!live);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [saved, setSaved] = useState<readonly string[]>([]);
  const [discount, setDiscount] = useState<AppliedDiscount | null>(null);
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [deliveryWish, setDeliveryWishes] = useState<Readonly<Record<string, DeliverySpeed>>>({});
  const [delivery, setDelivery] = useState<Readonly<Record<string, DeliveryChoice>>>({});
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [deliverTo, setDeliverTo] = useState<DeliverTo | null>(initialDeliverTo);
  const [loginOpen, setLoginOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [online, setOnlineState] = useState(true);
  // Offline the cart does not change; read by the cart changes, which stay stable callbacks.
  const onlineRef = useRef(true);
  const setOnline = useCallback((value: boolean) => {
    onlineRef.current = value;
    setOnlineState(value);
  }, []);
  useEffect(() => {
    setOnline(navigator.onLine);
    // The online event comes as soon as a network is up; check that the marketplace answers.
    const back = () => void reachable().then(setOnline);
    const lost = () => setOnline(false);
    window.addEventListener('online', back);
    window.addEventListener('offline', lost);
    return () => {
      window.removeEventListener('online', back);
      window.removeEventListener('offline', lost);
    };
  }, [setOnline]);
  const checkConnection = useCallback(async () => {
    const ok = await checkReachable();
    setOnline(ok);
    return ok;
  }, [setOnline]);
  const add = useCallback((id: string, unitPrice: Money, limit: number) => {
    if (onlineRef.current) setCart((current) => addOne(current, id, unitPrice, limit));
  }, []);
  const remove = useCallback((id: string) => {
    if (onlineRef.current) setCart((current) => removeOne(current, id));
  }, []);
  const dropLine = useCallback((id: string) => {
    if (onlineRef.current) setCart((current) => removeLine(current, id));
  }, []);
  const [stockChanges, setStockChanges] = useState<readonly StockChange[] | null>(null);
  const limitLines = useCallback((left: Readonly<Record<string, number>>) => {
    setCart((current) =>
      Object.entries(left).reduce((cart, [id, units]) => limitLine(cart, id, units), current),
    );
  }, []);
  const clearCart = useCallback(() => {
    setCart({});
    setDiscount(null);
    setNotes({});
    setDeliveryWishes({});
    setDelivery({});
  }, []);
  const saveForLater = useCallback((id: string) => {
    if (!onlineRef.current) return;
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
      if (!item || !onlineRef.current) return;
      setSaved((current) => current.filter((s) => s !== id));
      setCart((current) => addOne(current, id, item.price, lineLimit(item.lowStock)));
    },
    [cartSource],
  );
  const setNote = useCallback(
    (sellerId: string, note: string) => setNotes((current) => ({ ...current, [sellerId]: note })),
    [],
  );
  const setDeliveryWish = useCallback(
    (sellerId: string, speed: DeliverySpeed) =>
      setDeliveryWishes((current) => ({ ...current, [sellerId]: speed })),
    [],
  );
  // Live: the first load asks the API who is signed in (401 means nobody).
  useEffect(() => {
    if (!live) return;
    let current = true;
    void readCustomer().then((read) => {
      if (!current) return;
      if (read) setCustomer(read);
      setSessionReady(true);
    });
    return () => {
      current = false;
    };
  }, [live]);
  const signIn = useCallback(async (email: string, password: string): Promise<SignInOutcome> => {
    const result = await api.signIn(email, password);
    if (result.kind === 'signed-out') return 'wrong';
    if (result.kind === 'throttled') return 'throttled';
    if (result.kind === 'invalid') {
      if (result.code === 'email-verification-required') return 'unverified';
      return result.code === 'account.disabled' ? 'disabled' : 'failed';
    }
    if (result.kind !== 'ok') return 'failed';
    const read = await readCustomer();
    if (!read) return 'failed';
    setCustomer(read);
    return 'ok';
  }, []);
  // The buyer is logged out here only once the API ended the session (or it had already ended):
  // on a shared computer a live cookie would sign them back in on the next page.
  const signOut = useCallback(async (): Promise<boolean> => {
    if (live) {
      const result = await api.signOut();
      if (result.kind !== 'ok' && result.kind !== 'signed-out') return false;
    }
    setCustomer(null);
    return true;
  }, [live]);
  const value = useMemo(
    () => ({
      cart,
      add,
      remove,
      removeLine: dropLine,
      limitLines,
      stockChanges,
      setStockChanges,
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
      deliveryWish,
      setDeliveryWish,
      delivery,
      setDelivery,
      cartOpen,
      setCartOpen,
      customer,
      setCustomer,
      live,
      sessionReady,
      signIn,
      signOut,
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
      loginOpen,
      setLoginOpen,
      accountOpen,
      setAccountOpen,
      online,
      checkConnection,
    }),
    [
      cart,
      add,
      remove,
      dropLine,
      limitLines,
      stockChanges,
      clearCart,
      cartSource,
      saved,
      saveForLater,
      moveToCart,
      removeSaved,
      discount,
      notes,
      setNote,
      deliveryWish,
      setDeliveryWish,
      delivery,
      cartOpen,
      customer,
      live,
      sessionReady,
      signIn,
      signOut,
      deliveryAddress,
      placedOrder,
      browseOpen,
      searchOpen,
      filtersOpen,
      dialogOpen,
      deliverOpen,
      deliverTo,
      loginOpen,
      accountOpen,
      online,
      checkConnection,
    ],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/**
 * Reads the session and the address book: the customer, with the account's look applied (so it
 * follows the buyer to any device); null when signed out or when a read fails.
 */
async function readCustomer(): Promise<CheckoutCustomer | null> {
  const session = await api.readSession();
  if (session.kind !== 'ok') return null;
  const book = await api.listAddresses();
  if (book.kind !== 'ok') return null;
  const look = session.value.appearance;
  if (look?.palette) savePreference(PALETTE_COOKIE, 'palette', look.palette);
  if (look?.textSize) savePreference(TEXT_SIZE_COOKIE, 'textSize', look.textSize);
  return api.customerOf(session.value, book.value);
}

export function useStore(): StoreState {
  const state = useContext(StoreContext);
  if (!state) throw new Error('useStore outside StoreProvider');
  return state;
}
