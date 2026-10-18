'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { addOne, removeOne, type Cart } from '../cart/cart.ts';
import type { Money } from '../storefront/types.ts';

interface StoreState {
  readonly cart: Cart;
  readonly add: (id: string, unitPrice: Money, limit: number) => void;
  readonly remove: (id: string) => void;
  readonly browseOpen: boolean;
  readonly setBrowseOpen: (open: boolean) => void;
  readonly searchOpen: boolean;
  readonly setSearchOpen: (open: boolean) => void;
}

const StoreContext = createContext<StoreState | null>(null);

/** Client state shared by the shell and the page: the cart and the two overlays. */
export function StoreProvider({ children }: { readonly children: ReactNode }) {
  const [cart, setCart] = useState<Cart>({});
  const [browseOpen, setBrowseOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const add = useCallback(
    (id: string, unitPrice: Money, limit: number) =>
      setCart((current) => addOne(current, id, unitPrice, limit)),
    [],
  );
  const remove = useCallback((id: string) => setCart((current) => removeOne(current, id)), []);
  const value = useMemo(
    () => ({ cart, add, remove, browseOpen, setBrowseOpen, searchOpen, setSearchOpen }),
    [cart, add, remove, browseOpen, searchOpen],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreState {
  const state = useContext(StoreContext);
  if (!state) throw new Error('useStore outside StoreProvider');
  return state;
}
